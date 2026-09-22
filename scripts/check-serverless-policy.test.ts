import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkServerlessPolicy } from "./check-serverless-policy.js";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "policy-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  mkdirSync(join(root, "docs", "adr"), { recursive: true });
  writeFileSync(join(root, "docs", "adr", "015.md"), "# ADR-015");
  return root;
}

describe("NFR-16 serverless policy scanner", () => {
  it("passes a clean tree", () => {
    const root = fixture({
      "infra/sst.config.ts": `export default $config({ app: () => ({ name: "x", home: "aws" }) });`,
      "infra/stacks/index.ts": `const q = new sst.aws.Queue("Q"); const f = new sst.aws.Function("F", { handler: "h" });`,
    });
    expect(checkServerlessPolicy(root, ["infra"])).toEqual([]);
  });

  it("flags EC2 / EKS / always-on ECS / ElastiCache / MSK", () => {
    const root = fixture({
      "infra/stacks/bad.ts": [
        `const i = new aws.ec2.Instance("x", {});`,
        `const c = new aws.eks.Cluster("y", {});`,
        `const s = new aws.ecs.Service("z", {});`,
        `const r = new aws.elasticache.ReplicationGroup("a", {});`,
        `// AWS::MSK::Cluster`,
      ].join("\n"),
    });
    const violations = checkServerlessPolicy(root, ["infra"]);
    const patterns = violations.map((v) => v.pattern);
    expect(patterns).toContain("EC2 instance/resource");
    expect(patterns).toContain("EKS cluster");
    expect(patterns).toContain("ECS service or cluster");
    expect(patterns).toContain("self-hosted Redis (ElastiCache)");
    expect(patterns).toContain("self-hosted Kafka (MSK)");
    expect(violations[0]!.file).toContain("bad.ts");
    expect(violations[0]!.line).toBeGreaterThan(0);
  });

  it("allows a documented ADR exception when the ADR file exists", () => {
    const root = fixture({
      "infra/stacks/solver.ts": `// serverless-exception: ADR-015 (run-to-completion Fargate task for the solver)\nconst t = new aws.ecs.FargateService("solver", {});`,
    });
    expect(checkServerlessPolicy(root, ["infra"])).toEqual([]);
  });

  it("rejects an exception that references a missing ADR", () => {
    const root = fixture({
      "infra/stacks/solver.ts": `// serverless-exception: ADR-099 (made up)\nconst t = new aws.ecs.FargateService("solver", {});`,
    });
    const violations = checkServerlessPolicy(root, ["infra"]);
    expect(violations.some((v) => v.pattern.includes("missing ADR file"))).toBe(true);
  });

  it("skips directories that do not exist yet", () => {
    const root = fixture({});
    expect(checkServerlessPolicy(root, ["does-not-exist"])).toEqual([]);
  });
});

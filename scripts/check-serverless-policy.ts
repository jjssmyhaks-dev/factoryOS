/**
 * NFR-16: serverless policy check.
 *
 * Scans infrastructure-as-code for compute/services that violate the serverless
 * policy in PRD §4.2. Allowed without ADR: Lambda, Step Functions, API Gateway,
 * SQS, SNS, EventBridge, DynamoDB, S3, CloudFront, WAF, KMS, Secrets Manager,
 * IoT Core, CloudWatch, X-Ray, managed Postgres, and *run-to-completion* Fargate
 * (ADR-015). Everything else (EC2, EKS, always-on ECS/Fargate, self-hosted
 * Redis/Kafka/ClickHouse) fails the build unless an ADR-tagged exception comment
 * is present on the offending file.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface PolicyViolation {
  file: string;
  line: number;
  pattern: string;
  snippet: string;
}

const ROOT = process.cwd();
const SCAN_DIRS = ["infra", "services", "packages"];

/** Patterns that require an ADR exception (see §4.2 "Not allowed without an ADR"). */
const FORBIDDEN: Array<{ name: string; regex: RegExp }> = [
  { name: "EC2 instance/resource", regex: /\bnew\s+aws\.ec2\.\w+|AWS::EC2::/ },
  { name: "EKS cluster", regex: /\bnew\s+aws\.eks\.\w+|AWS::EKS::/ },
  { name: "ECS service or cluster", regex: /\bnew\s+aws\.ecs\.(Service|Cluster)\b|AWS::ECS::(Service|Cluster)/ },
  { name: "always-on Fargate service", regex: /\bnew\s+aws\.ecs\.(FargateService|Fargate)\b/ },
  { name: "self-hosted Redis (ElastiCache)", regex: /\bnew\s+aws\.elasticache\.\w+|AWS::ElastiCache::/ },
  { name: "self-hosted Kafka (MSK)", regex: /AWS::MSK::|aws\.msk\./ },
  { name: "self-hosted ClickHouse or similar stateful cluster", regex: /AWS::Redshift::|AWS::OpenSearchService::/ },
];

/** A file may opt out with: // serverless-exception: ADR-0xx (<reason>) */
const EXCEPTION_RE = /serverless-exception:\s*(ADR-\d{3})/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".sst", ".turbo", "dist", "coverage", ".git"].includes(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|json|ya?ml)$/.test(entry)) out.push(full);
  }
  return out;
}

export function checkServerlessPolicy(root: string = ROOT, dirs: string[] = SCAN_DIRS): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  for (const dir of dirs) {
    let files: string[];
    try {
      files = walk(join(root, dir));
    } catch {
      continue; // directory may not exist yet
    }
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (EXCEPTION_RE.test(text)) {
        if (!/docs\/adr\//.test(file)) {
          // Exception must reference an ADR that exists on disk.
          const adr = text.match(EXCEPTION_RE)?.[1];
          try {
            readFileSync(join(root, "docs", "adr", `${adr?.toLowerCase().replace("adr-", "")}.md`), "utf8");
          } catch {
            violations.push({
              file: relative(root, file),
              line: 0,
              pattern: `missing ADR file for exception ${adr}`,
              snippet: "serverless-exception comment references a non-existent ADR",
            });
          }
        }
        continue;
      }
      text.split("\n").forEach((line, i) => {
        for (const { name, regex } of FORBIDDEN) {
          if (regex.test(line)) {
            violations.push({ file: relative(root, file), line: i + 1, pattern: name, snippet: line.trim().slice(0, 160) });
          }
        }
      });
    }
  }
  return violations;
}

const isMain = process.argv[1]?.includes("check-serverless-policy");
if (isMain) {
  const violations = checkServerlessPolicy();
  if (violations.length > 0) {
    console.error("Serverless policy violations (PRD §4.2) — add an ADR or remove the resource:\n");
    for (const v of violations) console.error(`  ${v.file}:${v.line}  [${v.pattern}] ${v.snippet}`);
    process.exit(1);
  }
  console.log("serverless policy check: OK");
}

import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { demoEvalDeps } from "../src/demo-eval.js";
import { runCli } from "../src/cli.js";
import { loadDataset } from "../src/cli.js";
import { runEval } from "../src/runner.js";

const datasetsDir = fileURLToPath(new URL("../datasets", import.meta.url));

describe("demo agent eval over the golden dataset", () => {
  it("passes the §7.4 gate (must_catch green, adversarial side-effect free)", async () => {
    const deps = demoEvalDeps();
    const runner = await deps.runnerFor("demo", "mock");
    const dataset = loadDataset("demo-smoke", datasetsDir);
    const report = await runEval({
      dataset,
      agentId: "demo",
      agentVersion: await deps.agentVersion(),
      model: "mock",
      promptVersion: await deps.promptVersion(),
      runner,
    });
    expect(report.summary.n).toBe(dataset.cases.length);
    expect(report.gate.failures).toEqual([]);
    expect(report.gate.passed).toBe(true);
    // adversarial prompt-injection cases must be classified unknown/suggest
    const injection = report.results.find((r) => r.caseId === "adv-001-ignore")!;
    expect(injection.passed).toBe(true);
    expect(injection.sideEffects).toEqual([]);
  }, 30_000);

  it("CLI returns 0 on green and 2 on usage errors", async () => {
    const deps = demoEvalDeps();
    const ok = await runCli(["demo", "--dataset", "demo-smoke", "--out", join(process.cwd(), "eval-results-test")], deps);
    expect(ok).toBe(0);
    expect(await runCli([], deps)).toBe(2);
    expect(await runCli(["other", "--dataset", "demo-smoke"], deps)).toBe(2);
    expect(await runCli(["demo", "--dataset", "missing"], deps)).toBe(2);
  }, 30_000);
});

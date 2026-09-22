import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  decisionMatch,
  exactMatch,
  normalizedFieldMatch,
  numericTolerance,
  setMatch,
} from "../src/scorers.js";
import {
  DEFAULT_GATE,
  evaluateGate,
  summarize,
  type EvalCaseResult,
  type GateConfig,
} from "../src/gate.js";
import { parseArgs, loadDataset } from "../src/cli.js";
import { renderHtml, runEval, type GoldenDataset } from "../src/runner.js";

describe("scorers (§7.4)", () => {
  it("exactMatch compares JSON structure", () => {
    expect(exactMatch("e", { a: 1 }, { a: 1 }).pass).toBe(true);
    expect(exactMatch("e", { a: 1 }, { a: 2 }).pass).toBe(false);
  });

  it("normalizedFieldMatch ignores case and whitespace", () => {
    expect(normalizedFieldMatch("n", "  Invoice No 42 ", "invoice no 42").pass).toBe(true);
    expect(normalizedFieldMatch("n", "42", "43").pass).toBe(false);
  });

  it("numericTolerance allows ±₹1 by default", () => {
    expect(numericTolerance("t", 1000.5, 1000).pass).toBe(true);
    expect(numericTolerance("t", 1002, 1000).pass).toBe(false);
    expect(numericTolerance("t", null, 1000).pass).toBe(false);
    expect(numericTolerance("t", 1010, 1000, 15).pass).toBe(true);
  });

  it("setMatch is order-insensitive", () => {
    expect(setMatch("s", ["b", "a"], ["A", "B"]).pass).toBe(true);
    expect(setMatch("s", ["b"], ["a"]).pass).toBe(false);
    expect(setMatch("s", ["a", "a"], ["a"]).pass).toBe(false);
  });

  it("decisionMatch normalizes", () => {
    expect(decisionMatch("d", "Approve", "approve").pass).toBe(true);
    expect(decisionMatch("d", "auto", "approve").pass).toBe(false);
  });
});

function result(over: Partial<EvalCaseResult>): EvalCaseResult {
  return {
    caseId: "x",
    tags: [],
    weight: 1,
    scores: [],
    sideEffects: [],
    costInr: 0.01,
    passed: true,
    ...over,
  };
}

describe("gate (§7.4)", () => {
  const okResults: EvalCaseResult[] = [
    result({ caseId: "a", tags: ["must_catch"], costInr: 0.02 }),
    result({ caseId: "b", tags: ["adversarial"], costInr: 0.02 }),
    result({ caseId: "c", costInr: 0.02 }),
  ];

  it("passes when everything is green and no baseline is set", () => {
    const s = summarize(okResults);
    expect(evaluateGate(okResults, s, null)).toEqual([]);
  });

  it("fails when accuracy drops more than 0.5 pp vs baseline", () => {
    const results = [...okResults, result({ caseId: "d", passed: false, weight: 3 })];
    const s = summarize(results);
    const failures = evaluateGate(results, s, { accuracyPct: 95, avgCostInr: 0.02 });
    expect(failures.map((f) => f.rule)).toContain("accuracy_drop");
  });

  it("allows a drop within the configured tolerance", () => {
    const results = [...okResults, result({ caseId: "d", passed: false, weight: 0.01 })];
    const s = summarize(results);
    const failures = evaluateGate(results, s, { accuracyPct: 95, avgCostInr: 0.02 });
    expect(failures.map((f) => f.rule)).not.toContain("accuracy_drop");
  });

  it("fails when any must_catch case fails", () => {
    const results = [result({ caseId: "a", tags: ["must_catch"], passed: false, weight: 0 })];
    const failures = evaluateGate(results, summarize(results), null);
    expect(failures[0]!.rule).toBe("must_catch:must_catch");
    expect(failures[0]!.detail).toContain("a");
  });

  it("fails when an adversarial case produces a side effect (E6-S8)", () => {
    const results = [
      result({ caseId: "adv", tags: ["adversarial"], sideEffects: ["tally.post_receipt"] }),
    ];
    const failures = evaluateGate(results, summarize(results), null);
    expect(failures.map((f) => f.rule)).toContain("adversarial_side_effects");
    expect(failures[0]!.detail).toContain("tally.post_receipt");
  });

  it("fails when avg cost rises more than 10%", () => {
    const results = okResults.map((r) => ({ ...r, costInr: 0.05 }));
    const failures = evaluateGate(results, summarize(results), {
      accuracyPct: 90,
      avgCostInr: 0.02,
    });
    expect(failures.map((f) => f.rule)).toContain("cost_increase");
  });

  it("honours a custom config", () => {
    const custom: GateConfig = { ...DEFAULT_GATE, maxAccuracyDropPp: 100 };
    const results = [result({ caseId: "a", passed: false })];
    const failures = evaluateGate(results, summarize(results), { accuracyPct: 99, avgCostInr: 0 }, custom);
    expect(failures.map((f) => f.rule)).not.toContain("accuracy_drop");
  });
});

describe("summarize", () => {
  it("weights the pass rate by case weight", () => {
    const s = summarize([
      result({ passed: true, weight: 3, costInr: 0.1 }),
      result({ passed: false, weight: 1, costInr: 0.3 }),
    ]);
    expect(s.accuracyPct).toBe(75);
    expect(s.avgCostInr).toBeCloseTo(0.2);
    expect(s.totalCostInr).toBeCloseTo(0.4);
    expect(s.n).toBe(2);
  });

  it("handles the empty set", () => {
    expect(summarize([])).toEqual({ accuracyPct: 0, avgCostInr: 0, totalCostInr: 0, n: 0 });
  });
});

describe("runner + report", () => {
  const dataset: GoldenDataset = {
    name: "t",
    version: "1",
    agent_id: "demo",
    cases: [
      { id: "1", input_ref: {}, expected: {}, tags: ["must_catch"], weight: 1, source: "synthetic" },
      { id: "2", input_ref: {}, expected: {}, tags: [], weight: 1, source: "synthetic" },
    ],
  };

  it("runs cases sequentially and gates the report", async () => {
    const report = await runEval({
      dataset,
      agentId: "demo",
      agentVersion: "1.0.0",
      model: "mock",
      promptVersion: "p1",
      runner: async (c) => result({ caseId: c.id, passed: c.id === "1", tags: c.tags }),
    });
    expect(report.summary.n).toBe(2);
    // case 2 failed but carries no must_catch tag and there is no baseline → gate green
    expect(report.gate.failures).toEqual([]);
    expect(report.gate.passed).toBe(true);
  });

  it("renders HTML with escaping and gate banner", async () => {
    const report = await runEval({
      dataset: {
        ...dataset,
        cases: [{ id: "x<script>", input_ref: {}, expected: {}, tags: ["adversarial"], weight: 1, source: "adversarial" }],
      },
      agentId: "demo",
      agentVersion: "1.0.0",
      model: "mock",
      promptVersion: "p1",
      runner: async (c) => result({ caseId: c.id, tags: c.tags, passed: false, sideEffects: ["evil.tool"] }),
    });
    expect(report.gate.passed).toBe(false);
    const html = renderHtml(report);
    expect(html).toContain("GATE FAILED");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("evil.tool");
  });
});

describe("cli", () => {
  it("parses args", () => {
    expect(parseArgs(["demo", "--dataset", "demo-smoke", "--model", "m1"])).toEqual({
      agent: "demo",
      dataset: "demo-smoke",
      model: "m1",
    });
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs([])).toEqual({});
  });

  it("loads the shipped golden dataset (≥20 cases)", () => {
    const ds = loadDataset("demo-smoke", fileURLToPath(new URL("../datasets", import.meta.url)));
    expect(ds.cases.length).toBeGreaterThanOrEqual(20);
    expect(ds.cases.filter((c) => c.tags.includes("must_catch")).length).toBeGreaterThanOrEqual(3);
    expect(ds.cases.filter((c) => c.tags.includes("adversarial")).length).toBeGreaterThanOrEqual(4);
    expect(ds.cases.filter((c) => c.tags.includes("low_quality")).length).toBeGreaterThanOrEqual(
      Math.ceil(ds.cases.length * 0.2),
    );
    expect(ds.cases.filter((c) => c.tags.includes("hindi")).length).toBeGreaterThanOrEqual(
      Math.ceil(ds.cases.length * 0.1),
    );
  });

  it("throws for a missing dataset", () => {
    expect(() => loadDataset("nope", fileURLToPath(new URL("../datasets", import.meta.url)))).toThrow(
      /not found/,
    );
  });
});

import { describe, expect, it } from "vitest";
import { parseReport, pickLatest, toView, type EvalReportJson } from "../src/lib/eval-runner";

function fixture(): EvalReportJson {
  return {
    dataset: "demo-smoke",
    agentId: "demo",
    agentVersion: "1.0.0",
    model: "mock",
    promptVersion: "demo-1",
    generatedAt: "2026-09-22T11:00:00.000Z",
    summary: { accuracyPct: 97.5, avgCostInr: 0.01, totalCostInr: 0.26, n: 26 },
    gate: {
      failures: [{ rule: "must_catch:must_catch", detail: "1/1 failed: po-003-multi" }],
      passed: false,
    },
  };
}

describe("parseReport", () => {
  it("accepts a well-formed report", () => {
    const parsed = parseReport(JSON.stringify(fixture()));
    expect(parsed.agentId).toBe("demo");
    expect(parsed.summary.n).toBe(26);
    expect(parsed.gate.passed).toBe(false);
  });

  it("rejects payloads without summary/gate", () => {
    expect(() => parseReport("{}")).toThrow(/missing/);
    expect(() => parseReport('"nope"')).toThrow(/not an object/);
    expect(() => parseReport("not json")).toThrow();
  });
});

describe("pickLatest", () => {
  it("returns null for no candidates", () => {
    expect(pickLatest([])).toBeNull();
  });

  it("picks the newest entry by mtime", () => {
    const entries = [{ mtimeMs: 10 }, { mtimeMs: 40 }, { mtimeMs: 25 }];
    expect(pickLatest(entries)?.mtimeMs).toBe(40);
  });
});

describe("toView", () => {
  it("maps gate verdict, summary and run metadata", () => {
    const view = toView(fixture(), { durationMs: 1234, exitCode: 1, error: null });
    expect(view.gatePassed).toBe(false);
    expect(view.accuracyPct).toBe(97.5);
    expect(view.totalCostInr).toBe(0.26);
    expect(view.failures).toHaveLength(1);
    expect(view.failures[0]?.rule).toBe("must_catch:must_catch");
    expect(view.durationMs).toBe(1234);
    expect(view.exitCode).toBe(1);
    expect(view.error).toBeNull();
    expect(view.dataset).toBe("demo-smoke");
  });
});

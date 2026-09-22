import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MockProvider } from "../src/mock.js";
import {
  BudgetExceededError,
  RunBudget,
  TenantBudget,
  routeCompletion,
  type CompletionRequest,
  type ModelConfig,
  type ModelProvider,
  type RouterDeps,
} from "../src/router.js";

const config: ModelConfig = {
  routes: {
    classify: { model: "mock-a", fallback: "mock-b", maxTokens: 512 },
    extract: { model: "mock-a", fallback: "mock-b", maxTokens: 2048 },
    reason: { model: "mock-a", fallback: "mock-b", maxTokens: 1024 },
    draft: { model: "mock-a", fallback: "mock-b", maxTokens: 1024 },
    summarize: { model: "mock-a", fallback: "mock-b", maxTokens: 512 },
    plan: { model: "mock-a", fallback: "mock-b", maxTokens: 1024 },
  },
  maxInrPerRun: 1,
  maxInrPerTenantMonth: 100,
};

function makeDeps(
  providers: RouterDeps["providers"],
  opts: { runLimit?: number; tenantLimit?: number; onExceeded?: () => void } = {},
): RouterDeps {
  return {
    config,
    providers,
    providerFor: (m) => providers[m],
    runBudget: new RunBudget(opts.runLimit ?? 1),
    tenantBudget: new TenantBudget(opts.tenantLimit ?? 100, opts.onExceeded),
  };
}

const baseReq: CompletionRequest = {
  task: "classify",
  messages: [{ role: "user", content: "classify: invoice from Sharma" }],
};

describe("routeCompletion", () => {
  it("returns structured output validated against the schema", async () => {
    const schema = z.object({
      label: z.enum(["invoice", "po"]),
      confidence: z.number().min(0).max(1),
    });
    const provider = new MockProvider({
      fixtures: [{ match: "invoice", value: { label: "invoice", confidence: 0.98 } }],
    });
    const deps = makeDeps({ "mock-a": provider });
    const res = await routeCompletion(deps, { ...baseReq, schema });
    expect(res.value).toEqual({ label: "invoice", confidence: 0.98 });
    expect(res.usage.model).toBe("mock-a");
    expect(res.retries).toBe(0);
    expect(deps.runBudget.spentInr).toBeCloseTo(0.01);
    expect(deps.tenantBudget.spentInr).toBeCloseTo(0.01);
  });

  it("retries schema failures up to 2 times then succeeds", async () => {
    const schema = z.object({ ok: z.boolean() });
    let n = 0;
    const provider = new MockProvider({ defaultValue: undefined });
    provider.complete = (async (req, route) => {
      n++;
      const value = n < 3 ? { ok: "not-a-boolean" } : { ok: true };
      if (req.schema) {
        const parsed = req.schema.safeParse(value);
        if (!parsed.success) throw new Error("schema validation failed");
        return {
          value: parsed.data,
          retries: 0,
          usage: { model: route.model, inputTokens: 1, outputTokens: 1, costInr: 0.01, latencyMs: 1 },
        };
      }
      return {
        value,
        retries: 0,
        usage: { model: route.model, inputTokens: 1, outputTokens: 1, costInr: 0.01, latencyMs: 1 },
      };
    }) as ModelProvider["complete"];
    const deps = makeDeps({ "mock-a": provider });
    const res = await routeCompletion(deps, { ...baseReq, schema });
    expect(res.value).toEqual({ ok: true });
    expect(res.retries).toBe(2);
    expect(n).toBe(3);
  });

  it("falls back to the fallback provider after retries are exhausted", async () => {
    const primary = new MockProvider({ id: "mock-a", failFirst: 99 });
    const fallback = new MockProvider({
      id: "mock-b",
      defaultValue: { label: "invoice", confidence: 0.9 },
    });
    const deps = makeDeps({ "mock-a": primary, "mock-b": fallback });
    const res = await routeCompletion(deps, {
      ...baseReq,
      schema: z.object({ label: z.string(), confidence: z.number() }),
    });
    expect(res.usage.model).toBe("mock-b");
    expect(primary.calls.length).toBe(3);
    expect(fallback.calls.length).toBe(1);
  });

  it("throws when every provider fails", async () => {
    const primary = new MockProvider({ id: "mock-a", failFirst: 99 });
    const deps = makeDeps({ "mock-a": primary });
    await expect(routeCompletion(deps, baseReq)).rejects.toThrow();
  });

  it("throws for an unconfigured task", async () => {
    const deps = makeDeps({});
    await expect(
      routeCompletion(deps, { ...baseReq, task: "nope" as never }),
    ).rejects.toThrow(/no route configured/);
  });

  it("throws BudgetExceededError when the run budget is exhausted", async () => {
    const provider = new MockProvider({ id: "mock-a", costInr: 0.5, defaultValue: { x: 1 } });
    const deps = makeDeps({ "mock-a": provider }, { runLimit: 0.6 });
    await routeCompletion(deps, baseReq);
    await expect(routeCompletion(deps, baseReq)).rejects.toThrow(BudgetExceededError);
  });

  it("notifies on tenant budget exceeded and rejects", async () => {
    const provider = new MockProvider({ id: "mock-a", costInr: 10, defaultValue: { x: 1 } });
    let alerted = false;
    const deps = makeDeps(
      { "mock-a": provider },
      { tenantLimit: 15, runLimit: 100, onExceeded: () => (alerted = true) },
    );
    await routeCompletion(deps, baseReq);
    await expect(routeCompletion(deps, baseReq)).rejects.toThrow(BudgetExceededError);
    expect(alerted).toBe(true);
  });
});

describe("budgets", () => {
  it("RunBudget refuses charges above the limit without going negative", () => {
    const b = new RunBudget(1);
    expect(b.charge(0.6)).toBe(true);
    expect(b.charge(0.6)).toBe(false);
    expect(b.remainingInr).toBeCloseTo(0.4);
    expect(b.spentInr).toBeCloseTo(0.6);
  });

  it("TenantBudget accumulates across charges", () => {
    const b = new TenantBudget(5);
    expect(b.charge(2)).toBe(true);
    expect(b.charge(2)).toBe(true);
    expect(b.charge(2)).toBe(false);
    expect(b.spentInr).toBeCloseTo(4);
  });
});

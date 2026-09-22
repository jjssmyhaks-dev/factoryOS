import type { CompletionResult, CompletionRequest, ModelProvider, TaskRoute } from "./router.js";

/**
 * Mock provider: deterministic structured output for tests and evals.
 * Given a fixture map (prompt substring → value) it returns the first match,
 * otherwise it fails schema validation to exercise retry paths unless a
 * default is configured.
 */
export interface MockProviderOptions {
  id?: string;
  fixtures?: Array<{ match: string | RegExp; value: unknown }>;
  /** Returned when no fixture matches (default: throw). */
  defaultValue?: unknown;
  /** Cost charged per call in INR (default 0.01). */
  costInr?: number;
  /** Fail the first N calls (to test retries/fallback). */
  failFirst?: number;
}

export class MockProvider implements ModelProvider {
  readonly id: string;
  calls: CompletionRequest[] = [];
  private failures: number;

  constructor(private readonly opts: MockProviderOptions = {}) {
    this.id = opts.id ?? "mock";
    this.failures = opts.failFirst ?? 0;
  }

  async complete<T>(req: CompletionRequest, route: TaskRoute): Promise<CompletionResult<T>> {
    this.calls.push(req);
    if (this.failures > 0) {
      this.failures--;
      throw new Error("mock provider induced failure");
    }

    const text = req.messages.map((m) => m.content).join("\n");
    let value: unknown;
    const fixture = this.opts.fixtures?.find((f) =>
      typeof f.match === "string" ? text.includes(f.match) : f.match.test(text),
    );
    if (fixture) value = fixture.value;
    else if (this.opts.defaultValue !== undefined) value = this.opts.defaultValue;
    else throw new Error(`mock provider: no fixture for request: ${text.slice(0, 80)}`);

    if (req.schema) {
      const parsed = req.schema.safeParse(value);
      if (!parsed.success) throw new Error(`schema validation failed: ${parsed.error.message}`);
      value = parsed.data;
    }

    return {
      value: value as T,
      retries: 0,
      usage: {
        model: route.model,
        inputTokens: Math.ceil(text.length / 4),
        outputTokens: 20,
        costInr: this.opts.costInr ?? 0.01,
        latencyMs: 1,
      },
    };
  }
}

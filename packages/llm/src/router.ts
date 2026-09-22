import { z } from "zod";

/**
 * §6.7 model router: task class → model, fallback, token limit through
 * configuration. Nothing hard-coded: services inject a ModelConfig loaded
 * from env/DB. All budgets are [HYPOTHESIS] and configurable.
 */

export type TaskClass = "classify" | "extract" | "reason" | "draft" | "summarize" | "plan";

export interface TaskRoute {
  model: string;
  fallback: string;
  maxTokens: number;
}

export interface ModelConfig {
  routes: Record<TaskClass, TaskRoute>;
  /** Max ₹ per agent run (§6.7 budget); default from config. */
  maxInrPerRun: number;
  /** Max ₹ per tenant per month; exceeding → downgrade or pause + alert. */
  maxInrPerTenantMonth: number;
}

export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costInr: number;
  latencyMs: number;
  cacheHit?: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  task: TaskClass;
  messages: ChatMessage[];
  /** Structured-output schema; the provider must satisfy it or return an error. */
  schema?: z.ZodType;
  maxRetries?: number;
  /** Correlation for logs: tenant/run/step. */
  trace?: { tenant_id?: string; run_id?: string; step_name?: string };
}

export interface CompletionResult<T = unknown> {
  value: T;
  usage: Usage;
  retries: number;
}

export interface ModelProvider {
  readonly id: string;
  complete<T>(req: CompletionRequest, route: TaskRoute): Promise<CompletionResult<T>>;
}

/** Per-run budget tracker (§6.7). */
export class RunBudget {
  private spent = 0;
  constructor(readonly limitInr: number) {}

  get spentInr(): number {
    return this.spent;
  }

  get remainingInr(): number {
    return Math.max(0, this.limitInr - this.spent);
  }

  /** Returns false when the spend would exceed the budget (caller downgrades/pauses). */
  charge(costInr: number): boolean {
    if (this.spent + costInr > this.limitInr) return false;
    this.spent += costInr;
    return true;
  }
}

/** Tenant monthly budget with downgrade/pause semantics (§6.7). */
export class TenantBudget {
  private spent = 0;
  constructor(
    readonly limitInr: number,
    private readonly onExceeded: (spent: number) => void = () => undefined,
  ) {}

  get spentInr(): number {
    return this.spent;
  }

  /** true = allowed to spend; false = downgrade/pause and alert. */
  charge(costInr: number): boolean {
    if (this.spent + costInr > this.limitInr) {
      this.onExceeded(this.spent);
      return false;
    }
    this.spent += costInr;
    return true;
  }
}

export interface RouterDeps {
  config: ModelConfig;
  providers: Record<string, ModelProvider>;
  /** Primary provider id and fallback provider id per task route model key. */
  providerFor(model: string): ModelProvider | undefined;
  runBudget: RunBudget;
  tenantBudget: TenantBudget;
}

/**
 * Routes a completion: primary model → fallback on failure, enforces
 * structured output validation with up to 2 automatic retries (§6.7), and
 * charges both budgets.
 */
export async function routeCompletion<T>(
  deps: RouterDeps,
  req: CompletionRequest,
): Promise<CompletionResult<T>> {
  const route = deps.config.routes[req.task];
  if (!route) throw new Error(`no route configured for task: ${req.task}`);

  const attempts: Array<{ provider: ModelProvider; model: string }> = [];
  const primary = deps.providerFor(route.model);
  if (primary) attempts.push({ provider: primary, model: route.model });
  const fallback = deps.providerFor(route.fallback);
  if (fallback && fallback !== primary) attempts.push({ provider: fallback, model: route.fallback });
  if (attempts.length === 0) throw new Error(`no providers available for ${route.model}`);

  const maxRetries = req.maxRetries ?? 2;
  let lastError: unknown;

  for (const { provider, model } of attempts) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await provider.complete<T>(req, route);
        if (!deps.runBudget.charge(result.usage.costInr)) {
          throw new BudgetExceededError("run", deps.runBudget.spentInr);
        }
        if (!deps.tenantBudget.charge(result.usage.costInr)) {
          throw new BudgetExceededError("tenant_month", deps.tenantBudget.spentInr);
        }
        // Usage reports the model slot that actually produced the result —
        // a fallback provider must not be billed/logged under the primary.
        return { ...result, usage: { ...result.usage, model }, retries: attempt };
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        lastError = err;
        if (attempt === maxRetries) break; // fall through to fallback provider
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export class BudgetExceededError extends Error {
  constructor(
    readonly scope: "run" | "tenant_month",
    readonly spentInr: number,
  ) {
    super(`LLM budget exceeded (${scope}) after ₹${spentInr}`);
    this.name = "BudgetExceededError";
  }
}

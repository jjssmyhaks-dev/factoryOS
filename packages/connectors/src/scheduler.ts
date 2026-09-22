/**
 * E3-S3 sync scheduler: EventBridge Scheduler triggers a per-connection sync
 * through SQS → Lambda workers. This module holds the pure scheduling logic
 * the worker uses — cursors, exponential backoff with jitter, dead-lettering,
 * per-connection concurrency caps, and the 60-second stop rule for
 * paused/revoked connections. The SQS wiring lives in services/workers.
 */

export interface BackoffConfig {
  baseMs: number;
  maxMs: number;
  factor: number;
  jitterRatio: number; // 0..1 — fraction of the delay that is randomized
  maxAttempts: number; // attempts before the message goes to the DLQ
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  baseMs: 1_000,
  maxMs: 5 * 60_000,
  factor: 2,
  jitterRatio: 0.2,
  maxAttempts: 5,
};

/**
 * Exponential backoff with full-jitter component (§8.1 "exponential backoff
 * and dead-letter queue"). attempt is 1-based; attempt > maxAttempts means
 * "dead-letter now" (delay 0, dead flag set).
 */
export function backoffDelayMs(
  attempt: number,
  config: BackoffConfig = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): { delayMs: number; dead: boolean } {
  if (attempt <= 0) throw new Error(`attempt must be >= 1, got ${attempt}`);
  if (attempt > config.maxAttempts) return { delayMs: 0, dead: true };
  const exponential = config.baseMs * Math.pow(config.factor, attempt - 1);
  const capped = Math.min(exponential, config.maxMs);
  const jitter = capped * config.jitterRatio * (random() * 2 - 1); // ±jitterRatio
  return { delayMs: Math.max(0, Math.round(capped + jitter)), dead: false };
}

export type ConnectionLifecycle = "active" | "paused" | "revoked" | "degraded" | "pending";

export interface ConcurrencyLimiter {
  /** Reserves a slot; false when the per-connection cap is reached. */
  tryAcquire(key: string): boolean;
  release(key: string): void;
}

/**
 * Per-connection concurrency cap (E3-S3): a sync cannot exhaust database
 * connections. In Lambda this is backed by a DynamoDB counter; locally the
 * in-memory limiter below is used (and tested).
 */
export class InMemoryConcurrencyLimiter implements ConcurrencyLimiter {
  private readonly held = new Map<string, number>();

  constructor(private readonly perKeyLimit: number = 1) {}

  tryAcquire(key: string): boolean {
    const current = this.held.get(key) ?? 0;
    if (current >= this.perKeyLimit) return false;
    this.held.set(key, current + 1);
    return true;
  }

  release(key: string): void {
    const current = this.held.get(key) ?? 0;
    if (current <= 1) this.held.delete(key);
    else this.held.set(key, current - 1);
  }

  inFlight(key: string): number {
    return this.held.get(key) ?? 0;
  }
}

/** Max age (ms) of a lifecycle status after which it must be re-checked. */
export const STATUS_FRESHNESS_MS = 60_000; // "stops all jobs within 60 seconds" (E3-S3)

export interface StatusView {
  lifecycle: ConnectionLifecycle;
  fetchedAt: number;
}

/**
 * Decides whether a job may run *now*. Paused/revoked connections stop
 * within 60 s because the worker re-reads (or invalidates) status at least
 * that often — a stale "active" older than the freshness window is not
 * trusted to start new work.
 */
export function mayStartJob(status: StatusView, now: number): { allowed: boolean; reason?: string } {
  if (status.lifecycle === "revoked") return { allowed: false, reason: "revoked" };
  if (status.lifecycle === "paused") return { allowed: false, reason: "paused" };
  if (now - status.fetchedAt > STATUS_FRESHNESS_MS) {
    return { allowed: false, reason: "status_stale" };
  }
  return { allowed: true };
}

export interface SyncJobOutcome {
  ok: boolean;
  attempt: number;
  retryDelayMs: number;
  dead: boolean;
  error?: string;
  /** Pages and records processed — feeds §7.3 reliability metrics. */
  pages?: number;
  records?: number;
}

export interface SyncJobContext {
  connectionId: string;
  attempt: number;
  status: StatusView;
  now: number;
  limiter: ConcurrencyLimiter;
  backoff?: BackoffConfig;
  /** The actual sync work, owned by the connector. */
  run(): Promise<{ pages: number; records: number }>;
}

/**
 * One sync attempt with scheduling semantics: lifecycle gate → concurrency
 * gate → run → backoff/DLQ decision. Never throws for expected failures —
 * the worker maps the outcome to SQS retry / DLQ.
 */
export async function runSyncJob(ctx: SyncJobContext): Promise<SyncJobOutcome> {
  const backoff = ctx.backoff ?? DEFAULT_BACKOFF;

  const gate = mayStartJob(ctx.status, ctx.now);
  if (!gate.allowed) {
    // Not an error worth retrying: drop without backoff (status gate).
    return { ok: false, attempt: ctx.attempt, retryDelayMs: 0, dead: true, error: gate.reason };
  }

  if (!ctx.limiter.tryAcquire(ctx.connectionId)) {
    return {
      ok: false,
      attempt: ctx.attempt,
      retryDelayMs: backoffDelayMs(ctx.attempt, backoff).delayMs,
      dead: false,
      error: "connection_concurrency_limit",
    };
  }

  try {
    const result = await ctx.run();
    return {
      ok: true,
      attempt: ctx.attempt,
      retryDelayMs: 0,
      dead: false,
      pages: result.pages,
      records: result.records,
    };
  } catch (err) {
    const { delayMs, dead } = backoffDelayMs(ctx.attempt, backoff);
    return {
      ok: false,
      attempt: ctx.attempt,
      retryDelayMs: delayMs,
      dead,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    ctx.limiter.release(ctx.connectionId);
  }
}

import {
  InMemoryConcurrencyLimiter,
  runSyncJob,
  type ConnectionLifecycle,
  type Connector,
  type ConcurrencyLimiter,
} from "@factory/connectors";
import { createLogger, fromMessageAttributes, type Logger } from "@factory/observability";
import { z } from "zod";

/**
 * Sync worker (E3-S3): EventBridge Scheduler → SQS → this handler. Owns the
 * per-queue backpressure knobs conceptually (`maxConcurrency` per queue,
 * §4.3) via the injected limiter, and the paused/revoked stop rule.
 */

export const syncMessageSchema = z.object({
  channel: z.literal("sync"),
  tenant_id: z.string().min(1),
  connection_id: z.string().min(1),
  attempt: z.number().int().min(1).default(1),
  cursor: z.record(z.string(), z.unknown()).default({}),
});

export type SyncMessage = z.infer<typeof syncMessageSchema>;

export interface SyncWorkerDeps<Cfg, Cursor> {
  connector: Connector<Cfg, Cursor>;
  ctx: Parameters<Connector<Cfg, Cursor>["healthCheck"]>[0];
  lifecycle: () => Promise<ConnectionLifecycle>;
  statusFetchedAt: () => number;
  limiter?: ConcurrencyLimiter;
  logger?: Logger;
}

export async function handleSyncMessage<Cfg, Cursor>(
  deps: SyncWorkerDeps<Cfg, Cursor>,
  message: unknown,
  messageAttributes?: Record<string, { StringValue?: string }> | undefined,
): Promise<{ ok: boolean; pages: number; records: number }> {
  const parsed = syncMessageSchema.parse(message);
  const log = (deps.logger ?? createLogger({ level: "info" })).child({
    tenant_id: parsed.tenant_id,
    connection_id: parsed.connection_id,
  });
  const trace = fromMessageAttributes(messageAttributes);
  if (trace) log.info("sync attempt", { trace_id: trace.traceId, attempt: parsed.attempt });

  const limiter = deps.limiter ?? new InMemoryConcurrencyLimiter(2);
  const now = Date.now();
  const lifecycle = await deps.lifecycle();

  const outcome = await runSyncJob({
    connectionId: parsed.connection_id,
    attempt: parsed.attempt,
    status: { lifecycle, fetchedAt: deps.statusFetchedAt() },
    now,
    limiter,
    run: async () => {
      if (!deps.connector.sync) throw new Error(`${deps.connector.id} does not support read`);
      let pages = 0;
      let records = 0;
      for await (const page of deps.connector.sync(
        deps.ctx,
        parsed.cursor as unknown as Cursor,
      )) {
        pages++;
        records += page.records.length;
      }
      return { pages, records };
    },
  });

  if (!outcome.ok) {
    log.warn("sync not ok", {
      error: outcome.error ?? null,
      attempt: outcome.attempt,
      dead: outcome.dead,
      retry_delay_ms: outcome.retryDelayMs,
    });
    // dead → throw so SQS sends the message to the DLQ after retries;
    // retryable → throw with a marker the worker maps to a delay (SQS
    // backoff is managed by visibility timeout + maxReceiveCount).
    throw new SyncJobError(outcome.error ?? "sync failed", outcome);
  }

  log.info("sync ok", { pages: outcome.pages, records: outcome.records });
  return { ok: true, pages: outcome.pages ?? 0, records: outcome.records ?? 0 };
}

export class SyncJobError extends Error {
  constructor(
    message: string,
    readonly outcome: { attempt: number; retryDelayMs: number; dead: boolean; error?: string },
  ) {
    super(message);
    this.name = "SyncJobError";
  }
}

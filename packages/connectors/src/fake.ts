import type { ToolDefinition } from "@factory/harness";
import { backoffDelayMs, type BackoffConfig, DEFAULT_BACKOFF } from "./scheduler.js";
import type {
  CanonicalRecord,
  Connector,
  ConnCtx,
  Health,
  ConnectionStatus,
  RawRequest,
  CanonicalEvent,
  SyncPage,
} from "./types.js";

/**
 * FakeConnector — an in-memory connector used by the contract-test suite,
 * local dev and CI (no network). It deliberately exercises every branch the
 * contract checks: paging, cursors, health, webhook dedup.
 */

export interface FakeConnectorOptions {
  /** Records served on a full sync (default: 5 vouchers). */
  records?: CanonicalRecord[];
  /** Records per page (default 2). */
  pageSize?: number;
  /** Force authenticate() to this status. */
  authStatus?: ConnectionStatus;
  /** Fail the next N sync runs (for backoff/DLQ tests). */
  failRuns?: number;
  backoff?: BackoffConfig;
}

function defaultRecords(): CanonicalRecord[] {
  return Array.from({ length: 5 }, (_, i) => ({
    source: "fake",
    source_id: `VCH-${i + 1}`,
    kind: "voucher" as const,
    data: { amount: (i + 1) * 100, type: "Sales" },
    occurred_at: new Date("2026-09-01T00:00:00Z"),
  }));
}

export class FakeConnector implements Connector<Record<string, unknown>, { offset: number }> {
  readonly id = "fake";
  readonly capabilities: Array<"read" | "write" | "webhook" | "poll"> = [
    "read",
    "webhook",
    "poll",
  ];
  private failingRuns: number;
  readonly webhookSeen = new Set<string>();

  constructor(private readonly opts: FakeConnectorOptions = {}) {
    this.failingRuns = opts.failRuns ?? 0;
  }

  async authenticate(_ctx: ConnCtx): Promise<ConnectionStatus> {
    return this.opts.authStatus ?? { status: "active" };
  }

  async *sync(
    _ctx: ConnCtx,
    cursor: { offset: number },
  ): AsyncIterable<SyncPage<{ offset: number }>> {
    if (this.failingRuns > 0) {
      this.failingRuns--;
      throw new Error("fake connector induced failure");
    }
    const records = this.opts.records ?? defaultRecords();
    const pageSize = this.opts.pageSize ?? 2;
    let offset = cursor.offset;
    while (offset < records.length) {
      const page = records.slice(offset, offset + pageSize);
      offset += page.length;
      yield { records: page, nextCursor: { offset } };
    }
  }

  async handleWebhook(_ctx: ConnCtx, req: RawRequest): Promise<CanonicalEvent[]> {
    const key = req.dedupeKey ?? `sha:${req.body.length}`;
    if (this.webhookSeen.has(key)) return []; // idempotent: duplicates ignored
    this.webhookSeen.add(key);
    return [
      {
        event_type: "fake.received",
        entity_type: "document",
        payload: { bytes: req.body.length },
      },
    ];
  }

  tools(): ToolDefinition[] {
    return [];
  }

  async healthCheck(_ctx: ConnCtx): Promise<Health> {
    const status = this.opts.authStatus?.status ?? "active";
    return { status, lastSuccessAt: new Date(), lagSeconds: 0 };
  }

  /** Test helper: how many attempts until dead-letter for the given config. */
  static attemptsUntilDead(config: BackoffConfig = DEFAULT_BACKOFF): number[] {
    return Array.from({ length: config.maxAttempts + 1 }, (_, i) =>
      backoffDelayMs(i + 1, config, () => 0).delayMs,
    );
  }
}

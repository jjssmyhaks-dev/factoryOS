import type { ToolDefinition } from "@factory/harness";

/** §8.1 Connector interface — one folder per connector implementing this. */

export type ConnectionStatus =
  | { status: "active"; detail?: string }
  | { status: "degraded"; detail: string }
  | { status: "pending"; detail?: string }
  | { status: "paused"; detail?: string }
  | { status: "revoked"; detail?: string };

export interface Health {
  status: ConnectionStatus["status"];
  lastSuccessAt?: Date;
  lastError?: string;
  /** Seconds behind the source system's latest data. */
  lagSeconds?: number;
  detail?: string;
}

export interface CanonicalRecord {
  /** Stable id within the source system (Tally GUID, WhatsApp message id, …). */
  source_id: string;
  source: string;
  kind: "party" | "item" | "ledger" | "voucher" | "bill" | "document" | "message" | "lead";
  data: Record<string, unknown>;
  occurred_at?: Date;
}

export interface CanonicalEvent {
  event_type: string;
  entity_type: string;
  entity_id?: string;
  payload: Record<string, unknown>;
  occurred_at?: Date;
}

export interface RawRequest {
  headers: Record<string, string | undefined>;
  /** Raw body bytes — signatures are computed over the exact payload. */
  body: Uint8Array;
  /** Optional idempotency hint from the channel (message id, event id). */
  dedupeKey?: string;
}

export interface ConnCtx {
  tenantId: string;
  connectionId: string;
  config: Record<string, unknown>;
  /** Injected by the harness — connectors never read credentials directly. */
  getSecret(key: string): Promise<string>;
  now(): Date;
}

export interface SyncPage<Cursor> {
  records: CanonicalRecord[];
  nextCursor: Cursor;
}

export interface Connector<_Cfg = Record<string, unknown>, Cursor = Record<string, unknown>> {
  id: string;
  capabilities: Array<"read" | "write" | "webhook" | "poll">;
  authenticate(ctx: ConnCtx): Promise<ConnectionStatus>;
  sync?(ctx: ConnCtx, cursor: Cursor): AsyncIterable<SyncPage<Cursor>>;
  handleWebhook?(ctx: ConnCtx, req: RawRequest): Promise<CanonicalEvent[]>;
  /** Exposed to the harness and via the MCP server (E3-S1). */
  tools(): ToolDefinition[];
  healthCheck(ctx: ConnCtx): Promise<Health>;
}

/** Idempotent upsert key (§8.1): (tenant_id, source, source_id). */
export function recordKey(tenantId: string, record: CanonicalRecord): string {
  return `${tenantId}:${record.source}:${record.source_id}`;
}

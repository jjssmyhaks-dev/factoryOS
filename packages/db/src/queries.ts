import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { setTenant } from "./tenant.js";

// ─── E2-S2 append-only event log ───────────────────────────────────────────

export interface AppendEventInput {
  tenant_id: string;
  event_type: string;
  entity_type: string;
  entity_id?: string | null;
  actor_type: "user" | "agent" | "connector" | "system";
  actor_id?: string | null;
  payload: unknown;
  causation_id?: string | null;
  correlation_id?: string | null;
}

/**
 * Every domain mutation writes a `business_event` in the SAME transaction as
 * the mutation (E2-S2). Call inside the mutation's transaction with tenant
 * context already set.
 */
export async function appendEvent(client: PoolClient, input: AppendEventInput): Promise<string> {
  const res = await client.query(
    `insert into business_events
       (tenant_id, event_type, entity_type, entity_id, actor_type, actor_id, payload, causation_id, correlation_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     returning id`,
    [
      input.tenant_id,
      input.event_type,
      input.entity_type,
      input.entity_id ?? null,
      input.actor_type,
      input.actor_id ?? null,
      JSON.stringify(input.payload ?? {}),
      input.causation_id ?? null,
      input.correlation_id ?? null,
    ],
  );
  return String(res.rows[0].id as string);
}

export interface EventRow {
  id: string;
  event_type: string;
  entity_type: string;
  entity_id: string | null;
  payload: Record<string, unknown>;
  occurred_at: Date;
}

export async function eventsForEntity(
  client: PoolClient,
  tenantId: string,
  entityType: string,
  entityId: string,
): Promise<EventRow[]> {
  await setTenant(client, tenantId);
  const res = await client.query(
    `select id::text as id, event_type, entity_type, entity_id, payload, occurred_at
       from business_events
      where tenant_id = $1 and entity_type = $2 and entity_id = $3
      order by id asc`,
    [tenantId, entityType, entityId],
  );
  return res.rows as EventRow[];
}

/**
 * E2-S2 replay utility: rebuilds an entity's state from its events.
 * Convention: `*.created` events carry the initial snapshot, `*.updated`
 * events carry merge patches, `*.deleted` marks deletion. Returns null when
 * the entity was deleted or has no events.
 */
export function replayState(events: EventRow[]): Record<string, unknown> | null {
  let state: Record<string, unknown> | null = null;
  for (const ev of events) {
    const payload = ev.payload ?? {};
    if (ev.event_type.endsWith(".deleted")) {
      state = null;
    } else if (ev.event_type.endsWith(".created")) {
      state = { ...(payload as Record<string, unknown>) };
    } else if (ev.event_type.endsWith(".updated")) {
      state = { ...(state ?? {}), ...(payload as Record<string, unknown>) };
    } else if (state === null) {
      state = { ...(payload as Record<string, unknown>) };
    } else {
      const base: Record<string, unknown> = state ?? {};
      state = { ...base, ...(payload as Record<string, unknown>) };
    }
  }
  return state;
}

export async function replayEntity(
  client: PoolClient,
  tenantId: string,
  entityType: string,
  entityId: string,
): Promise<Record<string, unknown> | null> {
  return replayState(await eventsForEntity(client, tenantId, entityType, entityId));
}

// ─── E2-S3 idempotent mirror upserts ──────────────────────────────────────

export interface MirrorRow {
  tenant_id: string;
  source?: string;
  source_id: string;
  [key: string]: unknown;
}

const MIRROR_TABLES = new Set([
  "parties",
  "items",
  "ledger_mirror",
  "voucher_mirror",
  "bills_outstanding",
]);

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * Change detection across the pg/JS type gap: numeric and bigint columns
 * arrive as strings ("125000.50"), timestamps as Date, jsonb as objects.
 * Compare numbers numerically, dates by instant, the rest structurally.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (a instanceof Date || b instanceof Date) {
    return (
      new Date(a as string | number | Date).getTime() ===
      new Date(b as string | number | Date).getTime()
    );
  }
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  const na = Number(a);
  const nb = Number(b);
  if (a !== "" && b !== "" && Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Idempotent upsert keyed by `(tenant_id, source, source_id)` (E2-S3, §8.1).
 * Re-running the same sync produces zero net changes: when every data column
 * already matches we skip the write entirely, so `synced_at` and the row's
 * xmin are untouched.
 */
export async function upsertMirror(
  client: PoolClient,
  table: string,
  row: MirrorRow,
): Promise<{ inserted: boolean; changed: boolean; id: string }> {
  if (!MIRROR_TABLES.has(table)) throw new Error(`not a mirror table: ${table}`);
  const source = (row.source as string) ?? "tally";
  const dataColumns = Object.keys(row).filter(
    (c) => c !== "tenant_id" && c !== "source" && c !== "source_id" && IDENTIFIER_RE.test(c),
  );
  if (dataColumns.length === 0) throw new Error(`no data columns for ${table}`);

  // 1. Compare against the existing row (same statement snapshot semantics).
  const existing = await client.query(
    `select id::text as id, ${dataColumns.join(", ")} from ${table}
      where tenant_id = $1 and source = $2 and source_id = $3`,
    [row.tenant_id, source, row.source_id],
  );

  if ((existing.rowCount ?? 0) > 0) {
    const old = existing.rows[0] as Record<string, unknown>;
    const differs = dataColumns.some((c) => !sameValue(old[c], row[c]));
    if (!differs) {
      // Zero net changes — do not touch the row at all.
      return { id: old["id"] as string, inserted: false, changed: false };
    }
  }

  // 2. Insert or update.
  const cols = ["tenant_id", "source", "source_id", ...dataColumns];
  const values: unknown[] = [row.tenant_id, source, row.source_id];
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  dataColumns.forEach((c) => values.push(row[c]));

  const updateSet = dataColumns.map((c) => `${c} = excluded.${c}`);
  updateSet.push("synced_at = now()");

  const res = await client.query(
    `insert into ${table} (${cols.join(", ")})
     values (${placeholders.join(", ")})
     on conflict (tenant_id, source, source_id)
     do update set ${updateSet.join(", ")}
     returning id::text as id, (xmax = 0) as inserted`,
    values,
  );
  const out = res.rows[0] as { id: string; inserted: boolean };
  return { id: out.id, inserted: out.inserted, changed: true };
}

// ─── E2-S4 item alias memory ──────────────────────────────────────────────

export interface AliasLookup {
  item_id: string;
  confidence: number;
  source: string;
  confirmed: boolean;
  match_kind: "confirmed_exact" | "exact" | "embedding";
}

export interface AliasLookupOptions {
  /** Similarity threshold for unconfirmed embedding matches (configurable). */
  minEmbeddingConfidence?: number;
  /** 1536-dim embedding of the alias text (computed by the caller). */
  embedding?: number[] | null;
  partyId?: string | null;
}

/**
 * E2-S4: exact matches always beat embedding matches; confirmed aliases are
 * preferred; unconfirmed matches below the threshold are NEVER returned as
 * auto-applicable (caller must show a one-tap confirmation).
 */
export async function lookupItemAlias(
  client: PoolClient,
  tenantId: string,
  aliasText: string,
  opts: AliasLookupOptions = {},
): Promise<AliasLookup | null> {
  await setTenant(client, tenantId);
  const normalized = aliasText.trim().toLowerCase();

  const confirmed = await client.query(
    `select item_id, confidence, source from item_aliases
      where tenant_id = $1 and lower(alias_text) = $2 and confirmed_by is not null
      order by confidence desc limit 1`,
    [tenantId, normalized],
  );
  if ((confirmed.rowCount ?? 0) > 0) {
    const r = confirmed.rows[0];
    return {
      item_id: r.item_id,
      confidence: Number(r.confidence),
      source: r.source,
      confirmed: true,
      match_kind: "confirmed_exact",
    };
  }

  const exact = await client.query(
    `select item_id, confidence, source from item_aliases
      where tenant_id = $1 and lower(alias_text) = $2
      order by confidence desc limit 1`,
    [tenantId, normalized],
  );
  if ((exact.rowCount ?? 0) > 0) {
    const r = exact.rows[0];
    const confidence = Number(r.confidence);
    if (confidence >= 0.95) {
      return { item_id: r.item_id, confidence, source: r.source, confirmed: false, match_kind: "exact" };
    }
    // below the confirmed threshold → surfaced but not auto-applicable
    return null;
  }

  if (!opts.embedding || opts.embedding.length === 0) return null;

  const minConf = opts.minEmbeddingConfidence ?? 0.9;
  const vec = `[${opts.embedding.join(",")}]`;
  const res = await client.query(
    `select item_id, confidence, source, 1 - (embedding <=> $2::vector) as sim
       from item_aliases
      where tenant_id = $1 and embedding is not null
        ${opts.partyId ? "and (party_id = $3 or party_id is null)" : ""}
      order by embedding <=> $2::vector
      limit 5`,
    opts.partyId ? [tenantId, vec, opts.partyId] : [tenantId, vec],
  );
  for (const r of res.rows) {
    const similarity = Number(r.sim);
    if (similarity >= minConf) {
      return {
        item_id: r.item_id,
        confidence: Math.min(1, Math.max(0, similarity)),
        source: r.source,
        confirmed: false,
        match_kind: "embedding",
      };
    }
  }
  return null;
}

// ─── E0-S4 feature flags ──────────────────────────────────────────────────

export async function readFlags(
  pool: Pool,
  tenantId: string,
): Promise<Record<string, boolean>> {
  const client = await pool.connect();
  try {
    // The tenant GUC is transaction-local — it must be set inside the same
    // transaction as the query that relies on it (PgBouncer-safe pattern).
    await client.query("begin");
    await setTenant(client, tenantId);
    const res = await client.query(
      "select flag_key, enabled from feature_flags where tenant_id = $1",
      [tenantId],
    );
    await client.query("commit");
    const out: Record<string, boolean> = {};
    for (const r of res.rows as Array<{ flag_key: string; enabled: boolean }>) {
      out[r.flag_key] = r.enabled;
    }
    return out;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export async function writeFlag(
  pool: Pool,
  tenantId: string,
  flagKey: string,
  enabled: boolean,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await setTenant(client, tenantId);
    await client.query(
      `insert into feature_flags (tenant_id, flag_key, enabled, updated_at)
       values ($1, $2, $3, now())
       on conflict (tenant_id, flag_key)
       do update set enabled = excluded.enabled, updated_at = now()`,
      [tenantId, flagKey, enabled],
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

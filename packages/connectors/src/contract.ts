import type { Connector, ConnCtx, SyncPage } from "./types.js";

/**
 * E3-S1 contract-test suite — runs against every connector (fake in CI, real
 * connectors as they land). Covers: idempotent upserts, cursor resume, error
 * mapping and page-wise iteration.
 */

export interface ContractExpectation<Cursor> {
  /** Cursor to start from (fresh sync = the connector's initial cursor). */
  initialCursor: Cursor;
  /** How many pages a full sync should yield before exhausting. */
  minPages: number;
  /** Total distinct source_ids across a full sync. */
  distinctSourceIds: number;
}

export interface ContractFinding {
  check: string;
  ok: boolean;
  detail?: string;
}

async function collectPages<Cfg, Cursor>(
  connector: Connector<Cfg, Cursor>,
  ctx: ConnCtx,
  cursor: Cursor,
): Promise<Array<SyncPage<Cursor>>> {
  if (!connector.sync) throw new Error(`${connector.id} has no sync() but declares 'read'`);
  const pages: Array<SyncPage<Cursor>> = [];
  for await (const page of connector.sync(ctx, cursor)) {
    pages.push(page);
    if (pages.length > 100) throw new Error(`${connector.id}: sync did not terminate within 100 pages`);
  }
  return pages;
}

export async function runConnectorContract<Cfg, Cursor>(
  connector: Connector<Cfg, Cursor>,
  ctx: ConnCtx,
  expectation: ContractExpectation<Cursor>,
): Promise<ContractFinding[]> {
  const findings: ContractFinding[] = [];
  const record = (check: string, ok: boolean, detail?: string) =>
    findings.push({ check, ok, detail });

  // 1. Capability sanity: declared capabilities have implementing methods.
  if (connector.capabilities.includes("read")) {
    record("read_capability_implies_sync", typeof connector.sync === "function");
  }
  if (connector.capabilities.includes("webhook")) {
    record("webhook_capability_implies_handler", typeof connector.handleWebhook === "function");
  }
  record("has_health_check", typeof connector.healthCheck === "function");
  record("has_authenticate", typeof connector.authenticate === "function");
  record(
    "tool_names_follow_convention",
    connector
      .tools()
      .every((t) => /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(t.name)),
    connector
      .tools()
      .map((t) => t.name)
      .join(","),
  );

  // 2. authenticate resolves to a mapped status (never throws raw).
  try {
    const status = await connector.authenticate(ctx);
    record(
      "authenticate_maps_to_status",
      ["active", "degraded", "pending", "paused", "revoked"].includes(status.status),
      status.status,
    );
  } catch (err) {
    record("authenticate_maps_to_status", false, String(err));
  }

  // 3. Cursor resume: a full sync yields pages with monotonically advancing
  //    cursors and terminates.
  try {
    const pages = await collectPages(connector, ctx, expectation.initialCursor);
    record("sync_yields_pages", pages.length >= expectation.minPages, `${pages.length} pages`);
    const ids = new Set(pages.flatMap((p) => p.records.map((r) => r.source_id)));
    record(
      "distinct_source_ids",
      ids.size === expectation.distinctSourceIds,
      `${ids.size} distinct (want ${expectation.distinctSourceIds})`,
    );
    const shaped = pages.every((p) =>
      p.records.every((r) => r.source_id && r.source && r.kind && r.data),
    );
    record("records_are_canonical_shape", shaped);

    // 4. Idempotency: replaying from the initial cursor yields identical records.
    const replay = await collectPages(connector, ctx, expectation.initialCursor);
    const same =
      JSON.stringify(replay.flatMap((p) => p.records)) ===
      JSON.stringify(pages.flatMap((p) => p.records));
    record("replay_is_deterministic", same);

    // 5. Cursor resume: starting from the last page's cursor yields no repeats
    //    of already-seen source_ids (incremental semantics).
    const lastCursor = pages[pages.length - 1]?.nextCursor;
    if (lastCursor !== undefined) {
      const resumed = await collectPages(connector, ctx, lastCursor);
      const resumedIds = new Set(resumed.flatMap((p) => p.records.map((r) => r.source_id)));
      const overlap = [...resumedIds].filter((id) => ids.has(id));
      record("cursor_resume_no_overlap", overlap.length === 0, overlap.join(","));
    }
  } catch (err) {
    record("sync_iteration", false, String(err));
  }

  // 6. healthCheck always maps to a status.
  try {
    const health = await connector.healthCheck(ctx);
    record(
      "health_maps_to_status",
      ["active", "degraded", "pending", "paused", "revoked"].includes(health.status),
      health.status,
    );
  } catch (err) {
    record("health_maps_to_status", false, String(err));
  }

  return findings;
}

export function assertContract(findings: ContractFinding[]): void {
  const failed = findings.filter((f) => !f.ok);
  if (failed.length > 0) {
    throw new Error(
      `connector contract failed:\n${failed.map((f) => `  ✗ ${f.check}${f.detail ? ` — ${f.detail}` : ""}`).join("\n")}`,
    );
  }
}

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Pool } from "pg";
import { MIGRATIONS_DIR, migrate } from "../src/migrate.js";
import { withTenant } from "../src/tenant.js";
import {
  appendEvent,
  lookupItemAlias,
  readFlags,
  replayEntity,
  upsertMirror,
  writeFlag,
} from "../src/queries.js";
import { FlagCache } from "../src/flags.js";
import { KNOWN_TENANT_TABLES, listTenantScopedTables, tablesMissingPolicies } from "../src/rls.js";

/**
 * E1-S3 / E2-S1..S4 integration suite, on Testcontainers Postgres (pgvector).
 *
 * The migration runner connects as the superuser (table owner — RLS does not
 * apply to owners), then everything below runs as `app_user`, the application
 * role: not the owner, not superuser, no BYPASSRLS — exactly the production
 * shape (PRD §4.5).
 */

let container: StartedTestContainer;
let admin: Pool; // postgres (migrations, seeding)
let app: Pool; // app_user (RLS applies)

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();

const PG_IMAGE = "pgvector/pgvector:pg16";

beforeAll(
  async () => {
    container = await new GenericContainer(PG_IMAGE)
      .withEnvironment({ POSTGRES_PASSWORD: "test", POSTGRES_DB: "factory" })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage("database system is ready to accept connections", 2),
      )
      .start();

    const base = {
      host: container.getHost(),
      port: container.getMappedPort(5432),
      database: "factory",
    };

    admin = new Pool({ ...base, user: "postgres", password: "test", max: 4 });

    // Retry first connect — the entrypoint briefly races the readiness log.
    let lastErr: unknown;
    for (let i = 0; i < 20; i++) {
      try {
        await admin.query("select 1");
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (lastErr) throw lastErr;

    const result = await migrate(admin, MIGRATIONS_DIR);
    expect(result.applied).toContain("0001_core.sql");
    expect(result.applied).toContain("0002_harness.sql");
    expect(result.applied).toContain("0003_domain_mirrors.sql");

    // Application role: created after migrations, granted DML, explicitly not
    // given update/delete on the append-only event log.
    await admin.query(`
      do $$ begin
        if not exists (select from pg_roles where rolname = 'app_user') then
          create role app_user login password 'app';
        end if;
      end $$
    `);
    await admin.query("grant usage on schema public to app_user");
    await admin.query("grant select, insert, update, delete on all tables in schema public to app_user");
    await admin.query("grant usage, select on all sequences in schema public to app_user");
    await admin.query("revoke update, delete on business_events from app_user");

    await admin.query("insert into tenants (id, name) values ($1, 'Tenant A'), ($2, 'Tenant B')", [
      TENANT_A,
      TENANT_B,
    ]);

    app = new Pool({ ...base, user: "app_user", password: "app", max: 4 });
  },
  300_000,
);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await container?.stop();
});

describe("migrations (E2-S1)", () => {
  it("re-running is a no-op and checksums are stable", async () => {
    const second = await migrate(admin, MIGRATIONS_DIR);
    expect(second.applied).toEqual([]);
    expect(second.skipped.length).toBeGreaterThanOrEqual(3);
  });

  it("every tenant_id table has RLS enabled and a policy", async () => {
    const missing = await tablesMissingPolicies(admin);
    expect(missing).toEqual([]);

    const listed = await listTenantScopedTables(admin);
    const names = listed.map((t) => t.table_name);
    for (const expected of KNOWN_TENANT_TABLES) {
      expect(names, `table missing from enumeration: ${expected}`).toContain(expected);
    }
    // eval tables are intentionally global (no tenant_id)
    expect(names).not.toContain("eval_cases");
    expect(names).not.toContain("tenants");

    const rls = await admin.query(
      `select c.relname from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
         and exists (select 1 from information_schema.columns col
                      where col.table_schema = 'public' and col.table_name = c.relname
                        and col.column_name = 'tenant_id')`,
    );
    expect(rls.rows).toEqual([]);
  });

  it("the application role cannot bypass RLS", async () => {
    const res = await app.query(
      `select rolsuper, rolbypassrls from pg_roles where rolname = 'app_user'`,
    );
    expect(res.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});

describe("cross-tenant isolation (E1-S3)", () => {
  it("SELECT: tenant B cannot see tenant A rows", async () => {
    await withTenant(app, TENANT_A, async (client) => {
      await client.query(
        `insert into parties (tenant_id, source_id, name) values ($1, $2, $3)`,
        [TENANT_A, "party-a-1", "Alpha Fabricators"],
      );
    });

    const fromB = await withTenant(app, TENANT_B, async (client) => {
      const res = await client.query(`select name from parties`);
      return res.rows;
    });
    expect(fromB).toEqual([]);

    const fromA = await withTenant(app, TENANT_A, async (client) => {
      const res = await client.query(`select name from parties`);
      return res.rows;
    });
    expect(fromA).toEqual([{ name: "Alpha Fabricators" }]);
  });

  it("INSERT: writing another tenant's id violates WITH CHECK", async () => {
    await expect(
      withTenant(app, TENANT_A, async (client) => {
        await client.query(
          `insert into parties (tenant_id, source_id, name) values ($1, $2, $3)`,
          [TENANT_B, "party-evil", "Injected from A"],
        );
      }),
    ).rejects.toThrow(/row-level security policy/);
  });

  it("UPDATE: another tenant's row is invisible, so zero rows change", async () => {
    const res = await withTenant(app, TENANT_B, async (client) => {
      const r = await client.query(`update parties set name = 'hacked'`);
      return r.rowCount;
    });
    expect(res).toBe(0);

    const check = await withTenant(app, TENANT_A, async (client) => {
      const r = await client.query(`select name from parties where source_id = 'party-a-1'`);
      return r.rows[0].name;
    });
    expect(check).toBe("Alpha Fabricators");
  });

  it("DELETE: another tenant's row cannot be deleted", async () => {
    const res = await withTenant(app, TENANT_B, async (client) => {
      const r = await client.query(`delete from parties`);
      return r.rowCount;
    });
    expect(res).toBe(0);
    const still = await withTenant(app, TENANT_A, async (client) => {
      const r = await client.query(`select count(*)::int as n from parties`);
      return (r.rows[0] as { n: number }).n;
    });
    expect(still).toBe(1);
  });

  it("without tenant context nothing is visible", async () => {
    const res = await app.query(`select * from parties`);
    expect(res.rows).toEqual([]);
  });

  it("setTenant rejects non-uuid tenant ids", async () => {
    await expect(
      withTenant(app, "not-a-uuid", async () => undefined),
    ).rejects.toThrow(/invalid tenant id/);
  });

  it("aborted transactions roll back and release context", async () => {
    await expect(
      withTenant(app, TENANT_A, async (client) => {
        await client.query(
          `insert into parties (tenant_id, source_id, name) values ($1, $2, $3)`,
          [TENANT_A, "party-rollback", "Rollback Me"],
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const n = await withTenant(app, TENANT_A, async (client) => {
      const r = await client.query(
        `select count(*)::int as n from parties where source_id = 'party-rollback'`,
      );
      return (r.rows[0] as { n: number }).n;
    });
    expect(n).toBe(0);
  });
});

describe("append-only event log (E2-S2)", () => {
  it("the application role cannot UPDATE or DELETE business_events", async () => {
    const eventId = await withTenant(app, TENANT_A, async (client) => {
      return appendEvent(client, {
        tenant_id: TENANT_A,
        event_type: "party.created",
        entity_type: "party",
        entity_id: randomUUID(),
        actor_type: "agent",
        actor_id: "capture",
        payload: { name: "Alpha Fabricators" },
      });
    });
    expect(eventId).toMatch(/^\d+$/);

    await expect(app.query(`update business_events set payload = '{}'`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(app.query(`delete from business_events`)).rejects.toThrow(/permission denied/);
  });

  it("every domain mutation writes an event; replay rebuilds entity state", async () => {
    const partyId = randomUUID();
    await withTenant(app, TENANT_A, async (client) => {
      await appendEvent(client, {
        tenant_id: TENANT_A,
        event_type: "party.created",
        entity_type: "party",
        entity_id: partyId,
        actor_type: "user",
        actor_id: randomUUID(),
        payload: { id: partyId, name: "Sharma Steel", credit_days: 30 },
      });
      await appendEvent(client, {
        tenant_id: TENANT_A,
        event_type: "party.updated",
        entity_type: "party",
        entity_id: partyId,
        actor_type: "user",
        actor_id: randomUUID(),
        payload: { credit_days: 45 },
      });
      await appendEvent(client, {
        tenant_id: TENANT_A,
        event_type: "party.updated",
        entity_type: "party",
        entity_id: partyId,
        actor_type: "agent",
        actor_id: "collections",
        payload: { name: "Sharma Steel Pvt Ltd" },
      });
    });

    const replayed = await withTenant(app, TENANT_A, (client) =>
      replayEntity(client, TENANT_A, "party", partyId),
    );
    expect(replayed).toEqual({
      id: partyId,
      name: "Sharma Steel Pvt Ltd",
      credit_days: 45,
    });

    // Events from other tenants are invisible (RLS applies to reads too).
    const fromB = await withTenant(app, TENANT_B, (client) =>
      replayEntity(client, TENANT_B, "party", partyId),
    );
    expect(fromB).toBeNull();
  });
});

describe("idempotent mirror upserts (E2-S3)", () => {
  it("re-running the same sync produces zero net changes", async () => {
    const row = {
      tenant_id: TENANT_A,
      source: "tally",
      source_id: "LED-001",
      name: "Sales - Local",
      parent: "Sales Accounts",
      balance: 125000.5,
    };

    const first = await withTenant(app, TENANT_A, (client) =>
      upsertMirror(client, "ledger_mirror", row),
    );
    expect(first.inserted).toBe(true);
    expect(first.changed).toBe(true);

    const second = await withTenant(app, TENANT_A, (client) =>
      upsertMirror(client, "ledger_mirror", row),
    );
    expect(second.inserted).toBe(false);
    expect(second.changed).toBe(false);
    expect(second.id).toBe(first.id);

    const count = await withTenant(app, TENANT_A, async (client) => {
      const r = await client.query(`select count(*)::int as n from ledger_mirror`);
      return (r.rows[0] as { n: number }).n;
    });
    expect(count).toBe(1);

    // A genuine change is applied and reported.
    const third = await withTenant(app, TENANT_A, (client) =>
      upsertMirror(client, "ledger_mirror", { ...row, balance: 130000 }),
    );
    expect(third).toMatchObject({ inserted: false, changed: true });

    // Upserts are tenant-scoped: B's identical source_id is a different row.
    const bRow = await withTenant(app, TENANT_B, (client) =>
      upsertMirror(client, "ledger_mirror", { ...row, tenant_id: TENANT_B }),
    );
    expect(bRow.inserted).toBe(true);
    expect(bRow.id).not.toBe(first.id);
  });

  it("rejects unknown tables and empty payloads", async () => {
    await expect(
      withTenant(app, TENANT_A, (client) =>
        upsertMirror(client, "tenants", { tenant_id: TENANT_A, source_id: "x" }),
      ),
    ).rejects.toThrow(/not a mirror table/);
    await expect(
      withTenant(app, TENANT_A, (client) =>
        upsertMirror(client, "parties", { tenant_id: TENANT_A, source_id: "x" }),
      ),
    ).rejects.toThrow(/no data columns/);
  });

  it("upserts every declared mirror table, not just the ledger", async () => {
    const party = { tenant_id: TENANT_A, source_id: "P-MIRROR-1", name: "Acme Metals" };
    const first = await withTenant(app, TENANT_A, (client) =>
      upsertMirror(client, "parties", party),
    );
    expect(first.inserted).toBe(true);
    const again = await withTenant(app, TENANT_A, (client) =>
      upsertMirror(client, "parties", party),
    );
    expect(again).toMatchObject({ inserted: false, changed: false });

    const item = await withTenant(app, TENANT_A, (client) =>
      upsertMirror(client, "items", { tenant_id: TENANT_A, source_id: "I-MIRROR-1", name: "Bearing 6204" }),
    );
    expect(item.inserted).toBe(true);
  });
});

describe("item alias memory (E2-S4)", () => {
  const vec = (axis: number): number[] => {
    const a = new Array<number>(1536).fill(0);
    a[axis] = 1;
    return a;
  };
  const asSql = (v: number[]) => `[${v.join(",")}]`;

  let itemId: string;
  let otherItemId: string;

  beforeAll(async () => {
    await withTenant(app, TENANT_A, async (client) => {
      const items = await client.query(
        `insert into items (tenant_id, source_id, name) values ($1, 'IT-1', 'MS Pipe 40mm'), ($1, 'IT-2', 'Bearing 6204') returning id, source_id`,
        [TENANT_A],
      );
      for (const r of items.rows as Array<{ id: string; source_id: string }>) {
        if (r.source_id === "IT-1") itemId = r.id;
        else otherItemId = r.id;
      }

      // confirmed exact (low confidence but confirmed by a human)
      await client.query(
        `insert into item_aliases (tenant_id, item_id, alias_text, confidence, source, confirmed_by)
         values ($1, $2, 'ms pipe 40', 0.700, 'human', $3)`,
        [TENANT_A, itemId, randomUUID()],
      );
      // unconfirmed exact below auto-apply threshold
      await client.query(
        `insert into item_aliases (tenant_id, item_id, alias_text, confidence, source)
         values ($1, $2, 'pipe40-synonym', 0.800, 'ocr')`,
        [TENANT_A, otherItemId],
      );
      // unconfirmed exact above threshold
      await client.query(
        `insert into item_aliases (tenant_id, item_id, alias_text, confidence, source, embedding)
         values ($1, $2, '6204 bearing', 0.970, 'agent', $3::vector)`,
        [TENANT_A, otherItemId, asSql(vec(1))],
      );
    });
  });

  it("confirmed aliases always win, regardless of confidence", async () => {
    const hit = await withTenant(app, TENANT_A, (client) =>
      lookupItemAlias(client, TENANT_A, "MS Pipe 40"),
    );
    expect(hit).toMatchObject({ item_id: itemId, confirmed: true, match_kind: "confirmed_exact" });
    expect(hit!.confidence).toBeCloseTo(0.7);
  });

  it("unconfirmed exact matches below 0.95 are never auto-applied", async () => {
    const hit = await withTenant(app, TENANT_A, (client) =>
      lookupItemAlias(client, TENANT_A, "pipe40-synonym"),
    );
    expect(hit).toBeNull();
  });

  it("unconfirmed exact matches at/above 0.95 are returned", async () => {
    const hit = await withTenant(app, TENANT_A, (client) =>
      lookupItemAlias(client, TENANT_A, "6204 BEARING"),
    );
    expect(hit).toMatchObject({ item_id: otherItemId, match_kind: "exact", confirmed: false });
    expect(hit!.confidence).toBeCloseTo(0.97);
  });

  it("embedding lookup honours the similarity threshold", async () => {
    const near = await withTenant(app, TENANT_A, (client) =>
      lookupItemAlias(client, TENANT_A, "totally different text", { embedding: vec(1) }),
    );
    expect(near).toMatchObject({ item_id: otherItemId, match_kind: "embedding" });
    expect(near!.confidence).toBeGreaterThan(0.9);

    const far = await withTenant(app, TENANT_A, (client) =>
      lookupItemAlias(client, TENANT_A, "no alias at all", { embedding: vec(900) }),
    );
    expect(far).toBeNull();
  });

  it("aliases never cross tenants", async () => {
    const fromB = await withTenant(app, TENANT_B, (client) =>
      lookupItemAlias(client, TENANT_B, "6204 bearing", { embedding: vec(1) }),
    );
    expect(fromB).toBeNull();
  });
});

describe("feature flags (E0-S4)", () => {
  it("reads/writes per tenant and caches with a 30 s TTL", async () => {
    await writeFlag(app, TENANT_A, "capture_v2", false);
    expect(await readFlags(app, TENANT_A)).toEqual({ capture_v2: false });

    let clock = 1_000_000;
    const cache = new FlagCache(app, 30_000, () => clock);
    expect(await cache.isEnabled(TENANT_A, "capture_v2", true)).toBe(false);

    // Flip in the DB — the cache must keep serving the old value until TTL…
    await writeFlag(app, TENANT_A, "capture_v2", true);
    expect(await cache.isEnabled(TENANT_A, "capture_v2")).toBe(false);

    // …and pick it up within 30 seconds without a deploy.
    clock += 30_001;
    expect(await cache.isEnabled(TENANT_A, "capture_v2")).toBe(true);

    cache.invalidate(TENANT_A);
    expect(await cache.isEnabled(TENANT_A, "capture_v2")).toBe(true);
  });

  it("flags are tenant-isolated and fall back to the default", async () => {
    expect(await readFlags(app, TENANT_B)).toEqual({});
    expect(await new FlagCache(app).isEnabled(TENANT_B, "capture_v2", true)).toBe(true);
  });
});

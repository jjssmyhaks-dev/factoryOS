import type { Pool } from "pg";

/**
 * E1-S3: CI fails if a new tenant-scoped table lacks a policy or an
 * isolation test. The *policy* half runs live against the database here;
 * the migration-file half runs in scripts/check-rls-policies.ts (no DB
 * needed). The isolation tests are `test/rls.int.test.ts`.
 */

export interface TenantTableInfo {
  table_name: string;
  has_policy: boolean;
}

export async function listTenantScopedTables(pool: Pool): Promise<TenantTableInfo[]> {
  const res = await pool.query(`
    select c.relname as table_name,
           c.relrowsecurity as rls_enabled,
           exists (
             select 1 from pg_policies pol
              where pol.schemaname = n.nspname and pol.tablename = c.relname
           ) as has_policy
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'r'
       and n.nspname = 'public'
       and exists (
         select 1 from information_schema.columns col
          where col.table_schema = n.nspname
            and col.table_name = c.relname
            and col.column_name = 'tenant_id'
       )
     order by c.relname
  `);
  return (res.rows as Array<TenantTableInfo & { rls_enabled: boolean }>).map(
    ({ table_name, has_policy }) => ({ table_name, has_policy }),
  );
}

export async function tablesMissingPolicies(pool: Pool): Promise<string[]> {
  const all = await listTenantScopedTables(pool);
  return all.filter((t) => !t.has_policy).map((t) => t.table_name);
}

/** Tables the app role can mutate — used by isolation tests to iterate. */
export const KNOWN_TENANT_TABLES = [
  "memberships",
  "connections",
  "credentials",
  "documents",
  "business_events",
  "agent_runs",
  "agent_steps",
  "proposed_actions",
  "approvals",
  "autonomy_policies",
  "agent_stats",
  "feature_flags",
  "parties",
  "items",
  "item_aliases",
  "ledger_mirror",
  "voucher_mirror",
  "bills_outstanding",
  "staged_vouchers",
  "rate_history",
] as const;

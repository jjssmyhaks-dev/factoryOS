import type { Pool, PoolClient } from "pg";

/**
 * §4.5 tenancy pattern: each request/job starts a transaction and runs
 * `select set_config('app.tenant_id', $1, true)`. Transaction-local (third
 * arg `true`) keeps it compatible with the transaction-mode pooler. Never use
 * session-level `SET`.
 */
export async function beginTenant(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("begin");
  await setTenant(client, tenantId);
}

export async function setTenant(client: PoolClient, tenantId: string): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
    throw new Error(`invalid tenant id (must be uuid): ${tenantId}`);
  }
  await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
}

/** Run a unit of work inside a tenant-scoped transaction. */
export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await beginTenant(client, tenantId);
    try {
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (err) {
      await client.query("rollback");
      throw err;
    }
  } finally {
    client.release();
  }
}

/** Read the current tenant from the transaction-local setting (for guards). */
export async function currentTenant(client: PoolClient): Promise<string | null> {
  const res = await client.query(
    `select nullif(current_setting('app.tenant_id', true), '') as tenant_id`,
  );
  return (res.rows[0]?.tenant_id as string | undefined) ?? null;
}

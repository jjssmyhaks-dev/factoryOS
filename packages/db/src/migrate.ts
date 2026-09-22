import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

/**
 * Forward-only migration runner (Global DoD §0.4). Each `.sql` file is
 * applied exactly once inside a transaction and recorded with its checksum;
 * a changed checksum on an applied migration is a hard error (migrations are
 * immutable once merged — edits require a *new* migration).
 */

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(dir: string): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), "utf8");
      return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    });
}

export async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    create table if not exists schema_migrations (
      name text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(pool: Pool, dir: string): Promise<MigrateResult> {
  const files = loadMigrations(dir);
  const applied: string[] = [];
  const skipped: string[] = [];

  const client = await pool.connect();
  try {
    await client.query("begin");
    await ensureMigrationsTable(client);

    for (const file of files) {
      const existing = await client.query(
        "select checksum from schema_migrations where name = $1",
        [file.name],
      );
      if ((existing.rowCount ?? 0) > 0) {
        const row = existing.rows[0] as { checksum: string };
        if (row.checksum !== file.checksum) {
          throw new Error(
            `migration ${file.name} changed after being applied (checksum mismatch). ` +
              `Migrations are immutable — create a new migration instead.`,
          );
        }
        skipped.push(file.name);
        continue;
      }
      await client.query(file.sql);
      await client.query("insert into schema_migrations (name, checksum) values ($1, $2)", [
        file.name,
        file.checksum,
      ]);
      applied.push(file.name);
    }

    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
  return { applied, skipped };
}

export const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");

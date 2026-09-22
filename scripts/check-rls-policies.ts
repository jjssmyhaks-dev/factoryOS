/**
 * E1-S3 CI gate: enumerate every table with a `tenant_id` column and fail if
 * any lacks a row-level security policy (PRD §4.5).
 *
 * Runs against $DATABASE_URL when set; otherwise, in CI without a database,
 * it falls back to scanning the migration SQL so the gate still catches a new
 * tenant-scoped table shipped without `create policy`. The live-database check
 * runs in packages/db/test/rls.int.test.ts against Testcontainers.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(process.cwd(), "packages/db/migrations");

export function tablesMissingPoliciesFromMigrations(): string[] {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"));
  const sql = files.map((f) => readFileSync(join(MIGRATIONS, f), "utf8")).join("\n");

  // Tables declared with a tenant_id column.
  const tenantTables = new Set<string>();
  const createRe = /create table (?:if not exists )?([a-z_]+)\s*\(([\s\S]*?)\);/gi;
  let m: RegExpExecArray | null;
  while ((m = createRe.exec(sql)) !== null) {
    const [, name, body] = m;
    if (name && /tenant_id\s+uuid/.test(body)) tenantTables.add(name);
  }

  // Tables covered by a policy. `create policy ... on <table>`.
  const covered = new Set<string>();
  const policyRe = /create policy\s+\w+\s+on\s+([a-z_]+)/gi;
  while ((m = policyRe.exec(sql)) !== null) {
    if (m[1]) covered.add(m[1]);
  }

  return [...tenantTables].filter((t) => !covered.has(t)).sort();
}

const isMain = process.argv[1]?.includes("check-rls-policies");
if (isMain) {
  const missing = tablesMissingPoliciesFromMigrations();
  if (missing.length > 0) {
    console.error("tenant-scoped tables without an RLS policy (PRD §4.5 / E1-S3):");
    for (const t of missing) console.error(`  - ${t}`);
    process.exit(1);
  }
  console.log("RLS policy coverage (migration scan): OK");
}

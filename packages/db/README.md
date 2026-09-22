# @factory/db

Migrations, RLS policies, typed queries (ADR-003/011).

- `migrations/` — forward-only SQL, exactly per PRD §5.1–5.3. Every table with `tenant_id` ships with an RLS policy (§4.5, transaction-local `set_config('app.tenant_id', …, true)` — never session `SET`, compatible with the transaction-mode pooler).
- `src/migrate.ts` — forward-only runner, records applied migrations; each migration ships a written rollback plan in its PR (Global DoD §0.4).
- `src/tenant.ts` — `withTenant()` helper wrapping a transaction with tenant context.
- `src/queries.ts` — typed queries (events append + replay, mirrors idempotent upsert, aliases lookup).
- `src/flags.ts` — E0-S4 feature flags: DB-backed, per-tenant, in-memory cache with ≤ 30 s propagation.
- `src/rls.ts` — enumerates `tenant_id` tables missing policies (used by `pnpm check:rls` and the integration test).

Integration tests (`test/*.int.test.ts`) run against Testcontainers Postgres (pgvector image) and prove cross-tenant SELECT/INSERT/UPDATE/DELETE are all denied (E1-S3).

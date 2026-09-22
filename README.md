# Factory AI OS

> AI operations layer for Indian MSME manufacturers (INR, GST, WhatsApp-native).
> Serverless on AWS `ap-south-1`. Working name — rename before external use.

**PRD**: `docs/` mirrors the spec (ADR index at [docs/adr/README.md](docs/adr/README.md)).
**Status**: M0 foundations — monorepo, tenancy/RLS, core data model, harness skeleton, observability, eval gate.

## What this repo contains

| Package | What lives there |
|---|---|
| `packages/domain` | Pure entities, zod schemas, permission matrix (E1-S4), Appendix A autonomy defaults |
| `packages/observability` | Structured JSON logs, §7.2 redaction, span schema, SQS `traceparent` propagation, Sentry hook |
| `packages/llm` | Model router: task-class → model/fallback, structured-output retries, ₹ budgets |
| `packages/harness` | **The moat**: transition table (+ ASL generation), §6.4 policy engine, tool registry with `dryRun` gate |
| `packages/db` | Forward-only SQL migrations (§5.1–5.3 + mirrors), RLS pattern, tenant context, idempotent upserts, alias memory, feature flags |
| `packages/connectors` | §8.1 connector interface, contract-test suite, envelope-encrypted vault, sync scheduling (backoff/DLQ/caps) |
| `packages/agents` | Agent definitions + the **demo agent** (one traced run end to end — the M0 exit artifact) |
| `packages/evals` | §7.4 scorers, CI gate, CLI (`pnpm eval`), golden dataset `demo-smoke` (≥ 20 cases) |
| `packages/semantic`, `packages/ui` | Declared placeholders (E10 / E12) |
| `services/api` | Hono API: health, traced job enqueue, flags, auth + permission middleware |
| `services/ingress` | Webhook ingress: verify → persist → enqueue → 2xx |
| `services/workers` | Agent-run and sync queue handlers |
| `services/workflows` | **Generated** Step Functions ASL for the §6.3/§5.2 lifecycles |
| `services/jobs` | Fargate run-to-completion tasks (ADR-015) — placeholder |
| `apps/*` | Next.js consoles, operator PWA, Tally Bridge — placeholders for their epics |
| `infra/` | SST v3 (provisional, ADR-013): API, queues + DLQs, ingress, bucket |

## Quickstart (clean clone, no AWS needed)

```bash
pnpm install
pnpm ci        # lint + typecheck + unit tests + policy gates
```

Unit tests are hermetic. Integration tests need Docker (Testcontainers + LocalStack):

```bash
pnpm test:integration
```

Local API with an in-memory queue:

```bash
JWT_SECRET=dev-secret pnpm --filter @factory/api dev
```

Regenerate workflow definitions after editing `packages/harness/src/transitions.ts`:

```bash
pnpm --filter @factory/workflows generate
pnpm check:policies   # fails if ASL diverges from the transition table
```

## CI gates (Global DoD §0)

- `lint`, `typecheck`, unit tests (≥ 80% lines on `packages/domain` + `packages/harness`)
- Integration tests: Testcontainers (Postgres/pgvector) + LocalStack (SQS/S3)
- `check:policies` — NFR-16 serverless scan + workflow/transition-table consistency
- `check:rls` — every `tenant_id` table has an RLS policy (also enforced live in `db.int.test.ts`)
- `gitleaks` — no secrets in the repo
- `commitlint` — conventional commits on PRs

## Working rules (PRD §0)

1. Epics follow the §9.0 dependency graph; a story starts only when its dependencies are green.
2. Ambiguity → `docs/open-questions.md` with a proposed default, then proceed and flag it in the PR.
3. Zod schemas are the source of truth for every boundary.
4. LLM output is untrusted until validated by deterministic code — it never reaches an external system without the harness.
5. New tenant tables ship with RLS + cross-tenant isolation tests.
6. New agents/tools ship with schema, autonomy defaults, trace instrumentation and an eval suite (≥ 20 cases).
7. Small reviewable PRs, one story per PR, conventional commits.
8. Lasting decisions get an ADR in `docs/adr/`.

## Open assumptions flagged for the founder

- `docs/open-questions.md` (Q12–Q16: embedding dimension, Supabase claim mapping, OTP interim provider, payload offload threshold, SFN name-reuse window).
- ADR-007 (LLM data residency) is **open and blocks the first design partner** (§15.3).
- ADR-011 (Supabase vs Aurora) and ADR-013 (SST vs CDK) proceed on PRD defaults pending their spikes.

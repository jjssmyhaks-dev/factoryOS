# @factory/domain

Pure entities, zod schemas and business rules (PRD §5). **No I/O** — no fetch, no db, no fs.

- `permissions.ts` — E1-S4 role × capability matrix (tests per role in `test/permissions.test.ts`).
- `autonomy.ts` — Appendix A autonomy defaults as data; all values `[HYPOTHESIS]`, overridable per tenant via `autonomy_policies`.
- `action.ts` — §6.3 action states + `proposed_actions` row schema.
- `document.ts` — `documents` and `business_events` (append-only).
- `tenant.ts` — `tenants` / `memberships` schemas (roles per §5.1).
- `money.ts` — INR lakh/crore formatting (NFR-10), ledger-safe rounding.
- `gstin.ts` — GSTIN format + state-code → place of supply (checksum lands in E8-S3 after spike).

Coverage target ≥ 80% lines (Global DoD §0.1).

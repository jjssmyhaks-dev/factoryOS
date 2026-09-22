# @factory/llm

Model-agnostic wrapper (PRD §6.7, ADR-007/008):

- `router.ts` — task classes (`classify | extract | reason | draft | summarize | plan`) → model/fallback/token-limit **through configuration**, structured-output validation with ≤ 2 automatic retries, primary→fallback provider chain, per-run and per-tenant-month ₹ budgets (`RunBudget`, `TenantBudget`, `BudgetExceededError` → downgrade/pause + alert).
- `mock.ts` — deterministic `MockProvider` for tests, evals and CI (no network).

Provider adapters for the Anthropic API and Amazon Bedrock land in E6-S6 with **[VERIFY]** regional model availability. Every call must be recorded in `agent_steps` with tokens, latency and ₹ cost by the harness step wrapper.

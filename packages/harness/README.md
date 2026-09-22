# @factory/harness

The harness is the product's core moat (PRD §6). Nothing an agent does reaches the outside world except through it.

- `transitions.ts` — §6.3 action lifecycle + §5.2 agent-run **transition table** (single source of truth), `LifecycleGuard` (terminal-state + at-most-once-execution invariants), `ExecutionLedger`, approval-expiry helpers, and **ASL generators** for Step Functions. The JSON in `services/workflows/asl/` is generated from this table; `pnpm check:policies` fails CI on divergence (§6.9).
- `policy.ts` — §6.4 `decide()` policy engine: `min(configured, earned, global_max)`, kill switch cap, value threshold, confidence floor, limits (rate caps/quiet hours/allowlist), shadow mode. `computeEarnedLevel()` implements §6.4 earned autonomy against `agent_stats` (**[HYPOTHESIS]** thresholds in `EARNED_THRESHOLDS`).
- `registry.ts` — E6-S1 tool registry: zod in/out schemas, `external_write` **requires `dryRun`**, invalid input rejected *and traced*, MCP `tools/list` exposure with scopes.

Coverage target ≥ 80% lines (Global DoD §0.1). Eval suite: `packages/evals`.

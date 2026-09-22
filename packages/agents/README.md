# @factory/agents

Agent definitions (PRD §6.1): capture, collections, brief, quote, watchdog, planner — plus the **demo agent** used to prove the M0 exit criterion ("one traced agent run end to end").

- `src/demo.ts` — `demoAgent`: triggered by an event, runs reader → validator → planner → proposer through the harness, emits §7.2 spans, records `agent_runs`/`agent_steps`/`proposed_actions` through an injected `AgentStore`, and returns a policy decision. No side effects outside the store.
- `src/definition.ts` — `AgentDefinition` contract: id, semver, triggers, least-privilege tool list, model policy, default autonomy per action type, eval dataset name.
- `src/store.ts` — `AgentStore` port (the persistence boundary; `packages/db` provides the Postgres implementation, tests use the in-memory one).

Every new agent ships with: schema, autonomy-defaults entry (Appendix A), trace instrumentation, and an eval suite ≥ 20 cases (Global DoD §0.6) — see `packages/evals`.

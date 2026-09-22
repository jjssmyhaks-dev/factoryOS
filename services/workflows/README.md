# @factory/workflows

Step Functions definitions (ADR-002, §6.9):

- `asl/action-lifecycle.json` — the §6.3 action lifecycle. `pending_approval` is a `waitForTaskToken` Task with a 24 h timeout that routes `States.Timeout` → `expired`; every task catches to `failed`; terminal states are `Succeed`/`Fail` nodes.
- `asl/agent-run.json` — the §5.2 agent-run lifecycle.

**Both files are generated** from `packages/harness/src/transitions.ts`:

```bash
pnpm --filter @factory/workflows generate   # = tsx scripts/generate-workflows.ts
pnpm check:policies                        # fails CI when ASL diverges from the table
```

Workflows carry identifiers only (`action_id`, `tenant_id`, `run_id`) — Postgres is the state of record (§4.3 rule 2). Deployment of these definitions (and the step Lambdas behind `factory-ai-os-step`) lands in E6-S2 once AWS accounts exist.

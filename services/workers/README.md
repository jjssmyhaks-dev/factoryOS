# @factory/workers

SQS / EventBridge handlers (PRD §4.3 execution rules):

- `src/agent-run.ts` — `channel: "agent-run"` messages → traced demo-agent run (E0-S3 worker leg: extracts `traceparent` from message attributes so API → queue → worker is one trace). Schema-validated envelope; failures rethrow → SQS retries → DLQ.
- `src/sync.ts` — `channel: "sync"` messages → connector sync through the E3-S3 scheduling pattern (backoff, DLQ, per-connection concurrency cap, paused/revoked stop within 60 s).

Delivery is at-least-once everywhere: handlers must be idempotent. The final guard is the Postgres unique constraint on `(tenant_id, idempotency_key)` in `proposed_actions` (§4.3 rule 4).

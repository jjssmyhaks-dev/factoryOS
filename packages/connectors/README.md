# @factory/connectors

Connector framework (PRD §8):

- `src/types.ts` — the §8.1 `Connector` interface: `authenticate`, incremental `sync` (async iterable of pages + cursor), `handleWebhook`, `tools()` (exposed to the harness and via MCP), `healthCheck`.
- `src/contract.ts` — contract-test suite run against **every** connector: idempotent upserts keyed by `(tenant_id, source, source_id)`, cursor resume, error mapping, backoff classification, DLQ eligibility.
- `src/vault.ts` — E3-S2 credential vault: AES-256-GCM envelope encryption with per-tenant data keys; DEK wrapped by KMS (a `KmsLike` interface so tests use a local master key); rotation without downtime; plaintext never appears in logs (tested).
- `src/scheduler.ts` — E3-S3 sync pattern: exponential backoff + jitter, dead-letter after max attempts, per-connection concurrency cap, paused/revoked connections stop within 60 s.
- `src/health.ts` — E3-S4 connection health: status, last success, last error, lag → degraded alert.
- `src/fake.ts` — `FakeConnector` used by the contract tests and local dev.

Real connectors (tally, whatsapp, email, indiamart) live in per-folder submodules and must pass `runConnectorContract()` before registration (E3-S1).

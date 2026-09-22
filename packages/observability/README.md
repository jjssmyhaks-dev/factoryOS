# @factory/observability

- `logger.ts` — structured JSON logs; `tenant_id` + `request_id`/`run_id` on every line (Global DoD §0.3). Memory sink for tests.
- `redact.ts` — §7.2 redaction layer: phone/GSTIN/PAN/bank/email, `remove` or `hash` mode, recursive over payloads. Applied before anything is stored long-term or exported.
- `trace.ts` — §7.2 span attribute schema over `@opentelemetry/api` (the ADOT Lambda layer provides the SDK in AWS; without an SDK registered, spans are safe no-ops).
- `propagation.ts` — W3C `traceparent` carried through SQS message attributes (E0-S3 single-trace requirement).
- `sentry.ts` — reporter interface + `captureUnhandled` with tenant context (E0-S3).

ADR-008: in-house trace store + OpenTelemetry; Langfuse optional later.

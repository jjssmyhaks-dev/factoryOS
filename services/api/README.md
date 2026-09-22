# @factory/api

Hono HTTP API (ADR-012: Hono on Lambda behind API Gateway HTTP API, zod-validated routes).

- `src/app.ts` — M0 routes: `GET /healthz`, `POST /v1/jobs` (enqueue with a single trace, E0-S3), `GET /v1/flags/:key` (E0-S4), `GET /v1/me` (E1 auth/membership/permission chain).
- `src/auth.ts` — HS256 JWT verify (constant-time sig, expiry, issuer), `x-tenant-id` + membership resolution, `requireApprove(actionType)` / `requireMargins()` per the E1-S4 matrix. Supabase JWKS (RS256/ES256) lands with the real project — **[VERIFY]** claim mapping (docs/open-questions.md Q13).
- `src/queue.ts` — `JobQueue` port: `InMemoryQueue` (tests/dev) and `SqsQueue` (AWS) carrying W3C `traceparent` message attributes.
- `src/lambda.ts` — Lambda entry; `src/local.ts` — dev server with fakes; `src/bootstrap.ts` — env-only wiring (no secrets in the repo).

Run locally (no AWS needed):

```bash
JWT_SECRET=dev-secret pnpm --filter @factory/api dev
```

# infra/ — SST v3 (ADR-013)

Serverless-only IaC for `ap-south-1` (§4.2). EC2/EKS/always-on services are forbidden without an ADR — enforced by `pnpm check:policies` (NFR-16).

## Layout

- `sst.config.ts` — app config; stages `dev` / `staging` / `prod` map to **separate AWS accounts** (E0-S2).
- `stacks/index.ts` — M0 stacks: API (Hono Lambda), agent-run + sync SQS queues with DLQs, ingress Lambda, documents bucket.
- `sst-globals.d.ts` — ambient shims so `tsc` passes *before* `sst install` generates `.sst/platform/config.d.ts` (see the TODO in that file).

## Commands

```bash
pnpm install
pnpm --filter @factory/infra exec sst install       # generates platform types (one-time)
pnpm --filter @factory/infra dev --stage dev        # live dev
pnpm --filter @factory/infra deploy --stage staging
```

Secrets come from `.env.<stage>` (gitignored) or AWS Secrets Manager — never from the repo (Global DoD §0.8; `gitleaks` runs in CI).

## Deploy from CI (E0-S2)

`.github/workflows/deploy.yml` assumes an IAM role **via GitHub OIDC** (no long-lived keys). One-time per account: create the OIDC provider + role (runbook below), store the role ARN as a repo variable `AWS_ROLE_ARN`.

## Before first deploy — checklist (E0-S2)

- [ ] Three AWS accounts created (dev, staging, prod) + OIDC provider/role in each.
- [ ] Quota increases requested (docs/runbooks/aws-quotas.md).
- [ ] One-day SST vs CDK spike outcome recorded (docs/spikes/0001-sst-vs-cdk.md) — flip ADR-013 if blocked.
- [ ] Ephemeral per-PR stages enabled (`--stage pr-N`), destroyed on merge.

## Cost note

Everything here is pay-per-use. The Postgres database (Supabase, ADR-011) is managed outside this stack and is the documented always-on exception (§4.2).

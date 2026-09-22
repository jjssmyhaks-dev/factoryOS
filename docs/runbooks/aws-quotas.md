# Runbook: AWS quota increases (E0-S2, PRD §4.3)

New AWS accounts ship with low Lambda concurrency and reduced service quotas. Request increases in **week 1**, per stage (`dev`, `staging`, `prod`).

## Requested quotas

| Service | Quota | Requested value | Where |
|---|---|---|---|
| Lambda | Concurrent executions | 1,000 (from default 1,000 account-level, but burst concurrency on new accounts can be throttled — request clarity) | Service Quotas → AWS Lambda → "Concurrent executions" |
| Lambda | Unreserved account concurrency | ≥ 500 | Service Quotas |
| API Gateway | HTTP API rate/burst | 5,000 rps | Service Quotas → Amazon API Gateway |
| SQS | In-flight messages per queue | 120,000 (standard) | default usually sufficient |
| S3 | Bucket objects | 5,000 → no change needed | |
| EventBridge | events per second | 10,000 → default OK | |

## Procedure

1. Sign in to each AWS account (dev, staging, prod) as the deployment role.
2. Service Quotas console → search the quota → Request increase with the values above.
3. Record ticket IDs in this runbook's log below.
4. Confirm `Lambda concurrency` CloudWatch metric has headroom before M1 load tests.

## Log

| Date | Account | Quota | Ticket | Status |
|---|---|---|---|---|
| _pending (needs AWS accounts — E0-S2)_ | | | | |

## Verification

- [ ] Increases approved for staging and prod.
- [ ] A burst of 200 concurrent Lambda invocations completes without `Throttling` (script: `pnpm test:integration` exercises local concurrency only — real burst test happens at M1).

# Spike: SST v3 vs AWS CDK (ADR-013 / E0-S2)

**Date**: 2026-09-22
**Timebox**: one day
**Status**: partial — findings below are from docs review; the hands-on comparison (deploy a queue + Lambda to staging) is pending real AWS credentials.

## Question

Which IaC framework for the serverless stack: SST v3 (Ion) or raw AWS CDK?

## Findings so far

- SST v3 uses `$config({ app, run })` in `sst.config.ts`; components (`new sst.aws.*`) are Pulumi-based under the hood and CDK is not involved.
- SST v3 deploys through the `sst` CLI with stages (`--stage dev|staging|prod`), reads `.env.<stage>`, and supports Console autodeploy — maps cleanly onto our separate-AWS-accounts-per-stage plan (E0-S2).
- SST ships opinionated components for Lambda, SQS, API Gateway, StaticSite/Next.js (OpenNext integration), which is exactly our stack by layer (PRD §4.2).
- Raw CDK gives broader construct coverage (Step Functions patterns, IoT Core L2/L3s) but more boilerplate for Next.js deploys (needs `aws-cdk-lib` + custom assets or a separate pipeline).

## Decision (provisional, per PRD Q10 default)

**SST v3**, with AWS CDK as fallback. `infra/` is written against SST; the One-day hands-on spike is deferred to when AWS accounts exist (E0-S2) and this document will be updated with the outcome; if a blocker is found, ADR-013 flips to CDK.

## Verification pending

- [ ] `sst deploy --stage dev` of the M0 stacks to a real account (needs OIDC setup).
- [ ] Step Functions + IoT Core component coverage in SST v3 (fallback: CDK for those two stacks only).
- [ ] Cold-start and bundle-size sanity check with OpenNext.

# services/jobs

Fargate **run-to-completion** task images (ADR-015) — allowed only for jobs that exceed Lambda's 15-minute timeout:

- Phase 3 scheduling solver (E31)
- Bulk migrations (E14)
- Very large document batches (E8)

No always-on services (NFR-16 is enforced by `pnpm check:policies`). Contents arrive with the epics that need them.

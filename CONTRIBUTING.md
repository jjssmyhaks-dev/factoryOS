# Contributing to factoryOS

## PR-based workflow for `main`

`main` is protected (branch protection rules):

- **All changes land via pull request** — direct pushes are rejected,
  including for admins (`enforce_admins`).
- **Required status checks** (must be green *and* the branch up to date):
  - Lint, typecheck, unit tests
  - Integration tests (Testcontainers + LocalStack)
  - Coverage thresholds (domain, harness)
  - gitleaks
  - Conventional commits
- No force pushes, no branch deletions, stale reviews dismissed,
  conversations resolved before merge.
-0 approvals required by default (solo maintainer); add reviewers as the
team grows.

## Making a change

```sh
git checkout -b type/short-description   # conventional commit type
# ... edit, then verify locally:
pnpm typecheck && pnpm lint && pnpm test
git commit -m "type: short imperative summary"
git push -u origin HEAD
gh pr create --fill
gh pr merge --merge   # once CI is green
```

Commit messages must follow Conventional Commits (`feat:`, `fix:`,
`chore:`, `docs:`, `ci:`, `test:`, `refactor:`, …) — the
**Conventional commits** check enforces this on every PR.

The PR template lists the verification battery; tick every box before
requesting review.

## Local verification battery

| Command | Purpose |
| --- | --- |
| `pnpm typecheck` | `turbo run typecheck` across all packages |
| `pnpm lint` | ESLint over the whole workspace |
| `pnpm test` | unit + Testcontainers integration suites |
| `pnpm check:policies` | serverless + workflow/transition consistency |
| `pnpm check:rls` | RLS policy coverage |
| `pnpm eval demo --dataset demo-smoke --out eval-results` | §7.4 eval gate (exit 0 = pass) |

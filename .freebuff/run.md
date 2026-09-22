# Preview runbook — factory-ai-os

The registered preview is a **standalone HTML page** (no dev server): the §7.4
eval gate report produced by the project's own CLI. Every `apps/*` front-end is
an explicit milestone stub (their `dev` scripts only `echo`), so there is no web
UI to serve in M0 — the eval report is the richest viewable artifact.

## How to reproduce the artifacts

1. Install dependencies with the project package manager (pnpm workspace,
   Node >= 22):

   ```sh
   pnpm install
   ```

   Procedure note (fresh checkout): there are **no `.env` / `.env.local` files**
   in this repository — nothing to copy from the main checkout for the report.

2. Regenerate the eval report (writes JSON + HTML under `./eval-results/`):

   ```sh
   pnpm eval demo --dataset demo-smoke --out eval-results
   ```

   - Output page: `eval-results/demo-demo-smoke-<ISO-timestamp>.html`
     (timestamps in the filename — each run produces a new file; the JSON
     twin sits next to it).
   - Exit code `0` = GATE PASSED; `1` = gate failure; `2` = usage/data error.
   - The page embeds the §7.4 gate banner, per-case pass/fail rows, scores
     and cost, all self-contained (inline CSS, no network requests).

## How to run the server

**No server is required** — the registered preview uses static `htmlPath`
mode pointing at the generated report above.

For completeness: `pnpm dev` (→ `turbo run dev`) executes the placeholder
`dev` scripts in `apps/web`, `apps/operator-pwa` and `apps/ops-console`,
which only print where those apps land (E12 / E25 / E13) — nothing listens
on a port today. The backend services are HTTP servers (`pnpm --filter
@factory/api dev` etc., env-dependent) but nothing in the Preview relies on
them.

# Preview runbook — factory-ai-os

The registered preview is the **`apps/web` Next.js dev server** (customer
console) on `http://localhost:3000`. The §7.4 eval gate report remains
regenerable as a standalone HTML artifact and is also embedded live in the
console at `/evals`.

## How to reproduce the artifacts

1. Install dependencies with the project package manager (pnpm workspace,
   Node >= 22):

   ```sh
   pnpm install
   ```

   Procedure note (fresh checkout): there are **no `.env` / `.env.local` files**
   in this repository — nothing to copy from the main checkout.

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
   - Committed reports in `eval-results/` are the ones the console's
     `/evals` dashboard serves by default (newest first).

## How to run the server

Dev server for the console (from the repo root):

```sh
pnpm --filter @factory/web dev     # next dev, defaults to port 3000
```

- **Port:** Next.js default `3000`. If it is busy, set `PORT=<n>` in the
  environment before starting. Beware: a stray `PORT=0` in the shell makes
  Next bind an ephemeral port — pin `PORT=3000` explicitly if the preview
  URL must be stable.
- **Routes:** `/` overview, `/evals` live gate dashboard (Run eval button,
  watch toggle, embedded newest report), API routes `/api/eval/run`,
  `/api/eval/watch`, `/api/eval/report`.
- **No env vars required** — the eval runner shells out to
  `pnpm eval demo ...` in the repo, no keys needed.

Detached start (Windows PowerShell, survives the session; stdout/stderr
must be **different** files):

```powershell
$env:PORT='3000'
(Start-Process -FilePath 'npm.cmd' -ArgumentList 'run','dev' `
  -WorkingDirectory '<repo>\apps\web' `
  -RedirectStandardOutput '<repo>\.freebuff\preview.log' `
  -RedirectStandardError  '<repo>\.freebuff\preview.log.err' `
  -WindowStyle Hidden -PassThru).Id
```

Health check: `GET http://127.0.0.1:3000/` should answer `200` (probe with
plain Node `http` — some local `curl` setups refuse localhost).

The backend services (`pnpm --filter @factory/api dev` etc.) are separate
env-dependent HTTP servers; nothing in the preview relies on them.
`pnpm dev` at the root runs `turbo run dev`, which also starts the
remaining milestone stubs (`operator-pwa`, `ops-console` — echo-only).

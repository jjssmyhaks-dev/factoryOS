# @factory/evals

Eval harness (PRD §7.4): `pnpm eval <agent> --dataset <name> --model <id>` produces JSON + HTML reports and exits non-zero on gate failure.

- Scorers: exact/normalized field match, numeric tolerance (₹1), set match for line items, decision match, LLM-as-judge for free-text drafts (fixed rubric, human-audited sample — pluggable scorer, wired in E7-S3).
- CI gate defaults **[HYPOTHESIS]** (`DEFAULT_GATE`): critical-field accuracy drop ≤ 0.5 pp vs last released version; 100% pass on `must_catch` cases; zero side effects from `adversarial` cases; average cost per case within +10% of baseline.
- Runs on every PR touching a prompt, model config, tool schema, validator or agent graph (E7-S3).

Golden datasets live in `datasets/` (Appendix C: immutable once released; versions recorded per run). `demo-smoke` ships with ≥ 20 synthetic cases incl. `must_catch`, `adversarial`, low-quality and Hindi coverage for the demo agent (Global DoD §0.6).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_GATE,
  evaluateGate,
  summarize,
  type Baseline,
  type EvalCaseResult,
  type GateConfig,
  type GateFailure,
} from "./gate.js";

export interface GoldenCase {
  id: string;
  /** Inline input (or a reference) handed to the agent runner. */
  input_ref: unknown;
  expected: unknown;
  tags: string[];
  weight: number;
  source: "partner_anonymized" | "synthetic" | "adversarial";
}

export interface GoldenDataset {
  name: string;
  version: string;
  agent_id: string;
  cases: GoldenCase[];
}

export type CaseRunner = (c: GoldenCase) => Promise<EvalCaseResult>;

export interface EvalReport {
  dataset: string;
  datasetVersion: string;
  agentId: string;
  agentVersion: string;
  model: string;
  promptVersion: string;
  generatedAt: string;
  summary: ReturnType<typeof summarize>;
  results: EvalCaseResult[];
  gate: { config: GateConfig; failures: GateFailure[]; passed: boolean };
  baseline: Baseline | null;
  costInr: number;
}

export interface RunEvalOptions {
  dataset: GoldenDataset;
  agentId: string;
  agentVersion: string;
  model: string;
  promptVersion: string;
  runner: CaseRunner;
  baseline?: Baseline | null;
  gate?: GateConfig;
}

export async function runEval(opts: RunEvalOptions): Promise<EvalReport> {
  const results: EvalCaseResult[] = [];
  for (const c of opts.dataset.cases) {
    results.push(await opts.runner(c));
  }
  const summary = summarize(results);
  const gateConfig = opts.gate ?? DEFAULT_GATE;
  const failures = evaluateGate(results, summary, opts.baseline ?? null, gateConfig);
  return {
    dataset: opts.dataset.name,
    datasetVersion: opts.dataset.version,
    agentId: opts.agentId,
    agentVersion: opts.agentVersion,
    model: opts.model,
    promptVersion: opts.promptVersion,
    generatedAt: new Date().toISOString(),
    summary,
    results,
    gate: { config: gateConfig, failures, passed: failures.length === 0 },
    baseline: opts.baseline ?? null,
    costInr: summary.totalCostInr,
  };
}

export function renderHtml(report: EvalReport): string {
  const rows = report.results
    .map(
      (r) =>
        `<tr class="${r.passed ? "pass" : "fail"}"><td>${escapeHtml(r.caseId)}</td><td>${escapeHtml(r.tags.join(", "))}</td><td>${r.passed ? "PASS" : "FAIL"}</td><td>₹${r.costInr.toFixed(4)}</td><td>${escapeHtml(r.scores.filter((s) => !s.pass).map((s) => s.scorer).join(", "))}</td></tr>`,
    )
    .join("\n");
  const failures = report.gate.failures
    .map((f) => `<li><strong>${escapeHtml(f.rule)}</strong> — ${escapeHtml(f.detail)}</li>`)
    .join("\n");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Eval: ${escapeHtml(report.agentId)} @ ${escapeHtml(report.dataset)} v${escapeHtml(report.datasetVersion)}</title>
<style>
body{font-family:system-ui,sans-serif;margin:2rem;color:#111;background:#fff;color-scheme:light}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:.4rem .6rem;text-align:left}
.pass td:nth-child(3){color:#0a7d33;font-weight:600}.fail td:nth-child(3){color:#b3261e;font-weight:600}
.gate{padding:1rem;border-radius:6px;margin:1rem 0}.gate.ok{background:#e7f6ec}.gate.bad{background:#fdecea}
code{background:#f4f4f4;padding:.1rem .3rem}
</style></head><body>
<h1>Eval report — ${escapeHtml(report.agentId)} ${escapeHtml(report.agentVersion)}</h1>
<p>Dataset <code>${escapeHtml(report.dataset)} v${escapeHtml(report.datasetVersion)}</code> · model <code>${escapeHtml(report.model)}</code> · prompt <code>${escapeHtml(report.promptVersion)}</code> · ${escapeHtml(report.generatedAt)}</p>
<div class="gate ${report.gate.passed ? "ok" : "bad"}">
<strong>${report.gate.passed ? "GATE PASSED" : "GATE FAILED"}</strong>
accuracy ${report.summary.accuracyPct.toFixed(2)}% over ${report.summary.n} cases · total cost ₹${report.summary.totalCostInr.toFixed(4)} (avg ₹${report.summary.avgCostInr.toFixed(4)})
${failures ? `<ul>${failures}</ul>` : ""}
</div>
<table><thead><tr><th>case</th><th>tags</th><th>result</th><th>cost</th><th>failed scorers</th></tr></thead>
<tbody>${rows}</tbody></table>
</body></html>`;
}

export interface WriteReportOptions {
  report: EvalReport;
  outDir?: string;
}

/** Writes `<outDir>/<agent>-<dataset>-<ts>.json|.html`; returns the JSON path. */
export function writeReport(opts: WriteReportOptions): string {
  const dir = opts.outDir ?? join(process.cwd(), "eval-results");
  mkdirSync(dir, { recursive: true });
  const base = `${opts.report.agentId}-${opts.report.dataset}-${opts.report.generatedAt.replace(/[:.]/g, "-")}`;
  const jsonPath = join(dir, `${base}.json`);
  writeFileSync(jsonPath, JSON.stringify(opts.report, null, 2));
  writeFileSync(join(dir, `${base}.html`), renderHtml(opts.report));
  return jsonPath;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

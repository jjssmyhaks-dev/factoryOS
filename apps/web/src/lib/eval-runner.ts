/**
 * Runs the §7.4 eval CLI (`pnpm eval demo --dataset demo-smoke`) and turns
 * the newest report under ./eval-results into a view the dashboard renders.
 * Runner state lives on globalThis so Next.js dev HMR does not reset it.
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface EvalSummaryJson {
  accuracyPct: number;
  avgCostInr: number;
  totalCostInr: number;
  n: number;
}

export interface GateJson {
  failures: { rule: string; detail: string }[];
  passed: boolean;
}

/** The subset of the eval report JSON the dashboard consumes. */
export interface EvalReportJson {
  dataset: string;
  agentId: string;
  agentVersion: string;
  model: string;
  promptVersion: string;
  generatedAt: string;
  summary: EvalSummaryJson;
  gate: GateJson;
}

export interface EvalRunView {
  generatedAt: string;
  dataset: string;
  agentId: string;
  agentVersion: string;
  model: string;
  accuracyPct: number;
  avgCostInr: number;
  totalCostInr: number;
  n: number;
  gatePassed: boolean;
  failures: { rule: string; detail: string }[];
  durationMs: number | null;
  exitCode: number | null;
  error: string | null;
}

export interface HistoryPoint {
  generatedAt: string;
  accuracyPct: number;
  gatePassed: boolean;
}

export interface RunnerState {
  running: boolean;
  watch: boolean;
  pendingRerun: boolean;
  startedAt: string | null;
  lastRun: EvalRunView | null;
  history: HistoryPoint[];
}

/** Walks up from `startDir` until the pnpm workspace root is found. */
export function findRepoRoot(startDir: string = process.cwd()): string {
  let dir = resolve(startDir);
  for (let i = 0; i < 8; i++) {
    try {
      statSync(join(dir, "pnpm-workspace.yaml"));
      return dir;
    } catch {
      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
  }
  return resolve(startDir);
}

export function parseReport(raw: string): EvalReportJson {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) throw new Error("report is not an object");
  const r = parsed as { generatedAt?: unknown; summary?: unknown; gate?: unknown };
  if (
    typeof r.generatedAt !== "string" ||
    typeof r.summary !== "object" ||
    r.summary === null ||
    typeof r.gate !== "object" ||
    r.gate === null
  ) {
    throw new Error("report missing generatedAt/summary/gate");
  }
  return parsed as EvalReportJson;
}

export function pickLatest<T extends { mtimeMs: number }>(entries: readonly T[]): T | null {
  let best: T | null = null;
  for (const e of entries) {
    if (!best || e.mtimeMs > best.mtimeMs) best = e;
  }
  return best;
}

export function toView(
  report: EvalReportJson,
  meta: { durationMs: number | null; exitCode: number | null; error: string | null },
): EvalRunView {
  return {
    generatedAt: report.generatedAt,
    dataset: report.dataset,
    agentId: report.agentId,
    agentVersion: report.agentVersion,
    model: report.model,
    accuracyPct: report.summary.accuracyPct,
    avgCostInr: report.summary.avgCostInr,
    totalCostInr: report.summary.totalCostInr,
    n: report.summary.n,
    gatePassed: report.gate.passed,
    failures: report.gate.failures.map((f) => ({ rule: f.rule, detail: f.detail })),
    durationMs: meta.durationMs,
    exitCode: meta.exitCode,
    error: meta.error,
  };
}

interface LatestReport {
  report: EvalReportJson;
  htmlPath: string;
}

function readLatestReport(root: string): LatestReport | null {
  const dir = join(root, "eval-results");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const entries = names
    .filter((n) => n.endsWith(".json"))
    .map((n) => {
      const path = join(dir, n);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      return { path, mtimeMs };
    });
  const latest = pickLatest(entries);
  if (!latest) return null;
  try {
    const report = parseReport(readFileSync(latest.path, "utf8"));
    return { report, htmlPath: latest.path.replace(/\.json$/, ".html") };
  } catch {
    return null;
  }
}

/** Newest generated HTML report, or null when no eval has produced one yet. */
export function readLatestReportHtml(): string | null {
  const latest = readLatestReport(findRepoRoot());
  if (!latest) return null;
  try {
    return readFileSync(latest.htmlPath, "utf8");
  } catch {
    return null;
  }
}

type StoreGlobal = typeof globalThis & { __factoryEvalRunner?: RunnerState };

function store(): RunnerState {
  const g = globalThis as StoreGlobal;
  if (!g.__factoryEvalRunner) {
    const state: RunnerState = {
      running: false,
      watch: false,
      pendingRerun: false,
      startedAt: null,
      lastRun: null,
      history: [],
    };
    // Seed from the newest existing report so the dashboard opens populated.
    const seeded = readLatestReport(findRepoRoot());
    if (seeded) {
      const view = toView(seeded.report, { durationMs: null, exitCode: null, error: null });
      state.lastRun = view;
      state.history = [
        { generatedAt: view.generatedAt, accuracyPct: view.accuracyPct, gatePassed: view.gatePassed },
      ];
    }
    g.__factoryEvalRunner = state;
  }
  return g.__factoryEvalRunner;
}

export function getRunnerState(): RunnerState {
  return store();
}

interface CliOutcome {
  code: number | null;
  stderr: string;
  timedOut: boolean;
}

const RUN_TIMEOUT_MS = 120_000;

function runCli(root: string): Promise<CliOutcome> {
  return new Promise((done) => {
    const child = spawn("pnpm", ["eval", "demo", "--dataset", "demo-smoke"], {
      cwd: root,
      shell: process.platform === "win32",
      windowsHide: true,
    });
    let stderr = "";
    let timedOut = false;
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.stdout?.resume();
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, RUN_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ code: null, stderr: `${stderr}${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stderr, timedOut });
    });
  });
}

function failureView(
  outcome: CliOutcome,
  durationMs: number,
  latest: LatestReport | null,
): EvalRunView {
  const message = outcome.timedOut
    ? `eval run timed out after ${RUN_TIMEOUT_MS / 1000}s`
    : outcome.stderr.trim()
      ? outcome.stderr.trim().split("\n").slice(-4).join("\n")
      : `eval CLI exited with code ${outcome.code ?? "unknown"}`;
  if (latest) return toView(latest.report, { durationMs, exitCode: outcome.code, error: message });
  return {
    generatedAt: new Date().toISOString(),
    dataset: "-",
    agentId: "demo",
    agentVersion: "-",
    model: "-",
    accuracyPct: 0,
    avgCostInr: 0,
    totalCostInr: 0,
    n: 0,
    gatePassed: false,
    failures: [],
    durationMs,
    exitCode: outcome.code,
    error: message,
  };
}

async function executeRun(): Promise<EvalRunView> {
  const state = store();
  const root = findRepoRoot();
  const started = Date.now();
  const outcome = await runCli(root);
  const durationMs = Date.now() - started;
  const latest = readLatestReport(root);
  const view =
    latest && (outcome.code === 0 || outcome.code === 1)
      ? toView(latest.report, { durationMs, exitCode: outcome.code, error: null })
      : failureView(outcome, durationMs, latest);
  state.lastRun = view;
  state.history = [
    { generatedAt: view.generatedAt, accuracyPct: view.accuracyPct, gatePassed: view.gatePassed },
    ...state.history,
  ].slice(0, 20);
  return view;
}

/** Starts a run unless one is already in flight; returns null when busy. */
export async function startRun(): Promise<EvalRunView | null> {
  const state = store();
  if (state.running) return null;
  state.running = true;
  state.startedAt = new Date().toISOString();
  state.pendingRerun = false;
  try {
    return await executeRun();
  } finally {
    state.running = false;
    state.startedAt = null;
    if (state.pendingRerun) {
      state.pendingRerun = false;
      void startRun();
    }
  }
}

/** Queues a run (used by the file watcher): immediate, or pending when busy. */
export function requestRun(): void {
  const state = store();
  if (state.running) {
    state.pendingRerun = true;
    return;
  }
  void startRun();
}

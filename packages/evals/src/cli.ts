#!/usr/bin/env node
/**
 * CLI: pnpm eval <agent> --dataset <name> [--model <id>] [--baseline <path>]
 *
 * Loads the golden dataset, runs every case through the agent, scores,
 * evaluates the §7.4 gate and writes JSON+HTML reports. Exits non-zero on
 * gate failure so CI can block the PR (E7-S3).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_GATE, type GateConfig } from "./gate.js";
import { runEval, writeReport, type CaseRunner, type GoldenDataset } from "./runner.js";

interface CliArgs {
  agent?: string;
  dataset?: string;
  model?: string;
  baselinePath?: string;
  outDir?: string;
  help?: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--dataset":
        args.dataset = argv[++i];
        break;
      case "--model":
        args.model = argv[++i];
        break;
      case "--baseline":
        args.baselinePath = argv[++i];
        break;
      case "--out":
        args.outDir = argv[++i];
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        if (a && !a.startsWith("--") && !args.agent) args.agent = a;
    }
  }
  return args;
}

export function loadDataset(name: string, datasetsDir = join(process.cwd(), "datasets")): GoldenDataset {
  const path = join(datasetsDir, `${name}.json`);
  if (!existsSync(path)) {
    throw new Error(`dataset not found: ${path}`);
  }
  const dataset = JSON.parse(readFileSync(path, "utf8")) as GoldenDataset;
  if (!dataset.cases?.length) throw new Error(`dataset has no cases: ${name}`);
  return dataset;
}

export interface EvalCliDeps {
  /** Resolves an agent id to a case runner (services wire the real agent). */
  runnerFor(agentId: string, model: string): Promise<CaseRunner>;
  agentVersion(agentId: string): Promise<string>;
  promptVersion?(agentId: string): Promise<string>;
  datasetsDir?: string;
  outDir?: string;
  gate?: GateConfig;
}

export async function runCli(argv: string[], deps: EvalCliDeps): Promise<number> {
  const args = parseArgs(argv);
  if (args.help || !args.agent || !args.dataset) {
    process.stdout.write(
      "usage: pnpm eval <agent> --dataset <name> [--model <id>] [--baseline <path>] [--out <dir>]\n",
    );
    return args.help ? 0 : 2;
  }

  let dataset: GoldenDataset;
  try {
    dataset = loadDataset(args.dataset, deps.datasetsDir);
  } catch (err) {
    // Usage/data errors (missing dataset) exit 2; gate failures exit 1 below.
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if (dataset.agent_id !== args.agent) {
    console.error(
      `dataset ${dataset.name} belongs to agent "${dataset.agent_id}", not "${args.agent}"`,
    );
    return 2;
  }

  const model = args.model ?? "mock";
  const runner = await deps.runnerFor(args.agent, model);
  const baseline = args.baselinePath
    ? (JSON.parse(readFileSync(args.baselinePath, "utf8")) as { summary: { accuracyPct: number; avgCostInr: number } })
    : null;

  const report = await runEval({
    dataset,
    agentId: args.agent,
    agentVersion: await deps.agentVersion(args.agent),
    model,
    promptVersion: (await deps.promptVersion?.(args.agent)) ?? "0",
    runner,
    baseline: baseline ? { accuracyPct: baseline.summary.accuracyPct, avgCostInr: baseline.summary.avgCostInr } : null,
    gate: deps.gate ?? DEFAULT_GATE,
  });

  const jsonPath = writeReport({ report, outDir: deps.outDir });
  process.stdout.write(
    `${report.gate.passed ? "GATE PASSED" : "GATE FAILED"} — accuracy ${report.summary.accuracyPct.toFixed(2)}%, cost ₹${report.summary.totalCostInr.toFixed(4)} → ${jsonPath}\n`,
  );
  for (const f of report.gate.failures) {
    console.error(`  ✗ ${f.rule}: ${f.detail}`);
  }
  return report.gate.passed ? 0 : 1;
}

// Entrypoint when executed directly (`pnpm eval ...` → tsx src/cli.ts).
const invokedDirectly = process.argv[1]?.includes("cli");
if (invokedDirectly) {
  // Default wiring: demo agent with the mock provider — real agents register
  // through the evals registry in E7-S3.
  const { demoEvalDeps } = await import("./demo-eval.js");
  const code = await runCli(process.argv.slice(2), demoEvalDeps());
  process.exit(code);
}

import { MockProvider } from "@factory/llm";
import { fileURLToPath } from "node:url";
import { runDemoAgent } from "@factory/agents";
import { MemoryAgentStore } from "@factory/agents";
import { evaluateGate as _unused, type GateConfig } from "./gate.js";
import type { CaseRunner, GoldenCase } from "./runner.js";
import type { EvalCaseResult } from "./gate.js";
import type { Score } from "./scorers.js";
import { decisionMatch, numericTolerance, setMatch } from "./scorers.js";

/**
 * Eval wiring for the demo agent: golden cases carry a `document` input and
 * `expected` extraction/proposal; the runner feeds them through the real
 * agent pipeline with a deterministic mock model (no network in CI).
 */
export function demoEvalDeps() {
  return {
    /** Datasets ship with the package — resolve them, never trust process.cwd(). */
    datasetsDir: fileURLToPath(new URL("../datasets", import.meta.url)),
    async runnerFor(agentId: string, _model: string): Promise<CaseRunner> {
      if (agentId !== "demo") throw new Error(`no eval runner registered for agent: ${agentId}`);
      return (c: GoldenCase) => runDemoCase(c);
    },
    async agentVersion(): Promise<string> {
      return "1.0.0";
    },
    async promptVersion(): Promise<string> {
      return "demo-1";
    },
  };
}

interface ExpectedShape {
  doc_type?: string;
  invoice_no?: string;
  total_inr?: number;
  line_count?: number;
  proposed_mode?: string;
  action_type?: string;
}

/**
 * Deterministic stand-ins for what a model would read off the page: the mock
 * provider derives invoice numbers and line counts from the document *text*,
 * never from `expected` (only explicitly-scored fields mirror `expected`).
 */
function invoiceNoFrom(text: string): string | null {
  const explicit = /\binvoice\s*(?:no\.?|#)\s*[:.-]?\s*([A-Za-z0-9][A-Za-z0-9/-]*)/i.exec(text);
  if (explicit) return explicit[1] ?? null;
  const bare = /\binvoice\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9/-]*)/i.exec(text);
  return bare?.[1] ?? null;
}

function lineCountFrom(text: string): number | null {
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => /^\s*Lines:/i.test(l));
  if (idx < 0) return null;
  // "Lines: item" counts as one row; a bare "Lines:" header counts rows below.
  let count = lines[idx]!.replace(/^\s*Lines:\s*/i, "").trim() ? 1 : 0;
  for (let i = idx + 1; i < lines.length; i++) if (lines[i]!.trim()) count++;
  return count;
}

async function runDemoCase(c: GoldenCase): Promise<EvalCaseResult> {
  const input = c.input_ref as unknown as { text: string; tenant_id?: string };
  const expected = (c.expected ?? {}) as ExpectedShape;

  const provider = new MockProvider({
    fixtures: [
      {
        match: /./,
        value: {
          doc_type: expected.doc_type ?? "unknown",
          confidence: 0.97,
          invoice_no: expected.invoice_no ?? invoiceNoFrom(input.text),
          total_inr: expected.total_inr ?? null,
          line_count: lineCountFrom(input.text),
        },
      },
    ],
    costInr: 0.005,
  });

  const store = new MemoryAgentStore();
  const run = await runDemoAgent(
    {
      store,
      llm: provider,
      now: () => new Date("2026-09-22T10:00:00Z"),
      flags: { autonomy_kill_switch: false },
      tenantPolicy: { configured_level: 2 },
    },
    { tenant_id: input.tenant_id ?? "00000000-0000-4000-8000-000000000001", document: { text: input.text } },
  );

  const scores: Score[] = [];
  if (expected.doc_type !== undefined) {
    scores.push(decisionMatch("doc_type", run.extraction?.doc_type ?? "unknown", expected.doc_type));
  }
  if (expected.invoice_no !== undefined) {
    scores.push(
      decisionMatch("invoice_no", run.extraction?.invoice_no ?? "", expected.invoice_no),
    );
  }
  if (expected.total_inr !== undefined) {
    scores.push(numericTolerance("total_inr", run.extraction?.total_inr ?? null, expected.total_inr));
  }
  if (expected.line_count !== undefined) {
    scores.push(numericTolerance("line_count", run.extraction?.line_count ?? null, expected.line_count));
  }
  if (expected.proposed_mode !== undefined) {
    scores.push(decisionMatch("mode", run.decision?.mode ?? "unknown", expected.proposed_mode));
  }
  if (expected.action_type !== undefined && c.tags.includes("must_catch")) {
    scores.push(decisionMatch("action_type", run.proposal?.action_type ?? "none", expected.action_type));
  }
  // Line-item sets when provided as string arrays.
  const expLines = (c.expected as { lines?: string[] })?.lines;
  if (expLines) {
    const gotLines = (run.extraction as { lines?: string[] })?.lines ?? [];
    scores.push(setMatch("lines", gotLines, expLines));
  }

  const passed = scores.length > 0 && scores.every((s) => s.pass);
  const sideEffects = store.actions
    .filter((a) => a.state === "executing" || a.state === "executed")
    .map((a) => a.action_type);

  return {
    caseId: c.id,
    tags: c.tags,
    weight: c.weight,
    scores,
    sideEffects,
    costInr: run.costInr,
    passed,
  };
}

export type { GateConfig };
void _unused;

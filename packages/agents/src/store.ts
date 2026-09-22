import type { ProposedAction } from "@factory/domain";

/** Recorded step (§7.2 `agent_steps` row minus DB plumbing). */
export interface StepRecord {
  seq: number;
  kind: "llm" | "tool" | "validator" | "policy" | "human";
  name: string;
  model?: string;
  prompt_version?: string;
  input_tokens?: number;
  output_tokens?: number;
  latency_ms?: number;
  cost_inr?: number;
  outcome: "ok" | "invalid" | "error" | "blocked";
  input_ref?: unknown;
  output_ref?: unknown;
}

export interface RunRecord {
  id: string;
  tenant_id: string;
  agent_id: string;
  agent_version: string;
  trigger: unknown;
  status: "running" | "succeeded" | "failed" | "cancelled";
  mode: "live" | "shadow" | "replay";
  started_at: Date;
  finished_at?: Date;
  cost_inr: number;
  trace_id?: string;
  steps: StepRecord[];
  error?: string;
}

export interface DecisionRecord {
  action_type: string;
  state: ProposedAction["state"];
  decided_mode?: ProposedAction["decided_mode"];
  decision_reason?: unknown;
}

/**
 * Persistence port for agent runs (§5.2). `packages/db` provides the
 * Postgres implementation; tests and evals use {@link MemoryAgentStore}.
 */
export interface AgentStore {
  startRun(run: Omit<RunRecord, "status" | "finished_at" | "cost_inr" | "steps">): Promise<void>;
  addStep(runId: string, step: StepRecord): Promise<void>;
  finishRun(runId: string, status: RunRecord["status"], costInr: number, error?: string): Promise<void>;
  saveAction(runId: string, tenantId: string, action: DecisionRecord & { payload: unknown; summary: string; idempotency_key: string; confidence?: number; value_inr?: number }): Promise<void>;
}

export class MemoryAgentStore implements AgentStore {
  readonly runs = new Map<string, RunRecord>();
  readonly actions: Array<DecisionRecord & { run_id: string; tenant_id: string; idempotency_key: string }> = [];

  async startRun(run: Omit<RunRecord, "status" | "finished_at" | "cost_inr" | "steps">): Promise<void> {
    this.runs.set(run.id, { ...run, status: "running", cost_inr: 0, steps: [] });
  }

  async addStep(runId: string, step: StepRecord): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown run: ${runId}`);
    run.steps.push(step);
  }

  async finishRun(runId: string, status: RunRecord["status"], costInr: number, error?: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown run: ${runId}`);
    run.status = status;
    run.cost_inr = costInr;
    run.finished_at = new Date();
    if (error) run.error = error;
  }

  async saveAction(
    runId: string,
    tenantId: string,
    action: DecisionRecord & { payload: unknown; summary: string; idempotency_key: string; confidence?: number; value_inr?: number },
  ): Promise<void> {
    this.actions.push({ ...action, run_id: runId, tenant_id: tenantId });
  }
}

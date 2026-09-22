import type { AutonomyLevel } from "@factory/domain";

/** §6.1 AgentDefinition — the contract every agent must satisfy. */
export type Trigger =
  | { kind: "event"; event_type: string }
  | { kind: "schedule"; cron: string; timezone?: string }
  | { kind: "message"; channel: "whatsapp" | "email" | "api" };

export interface ModelPolicyEntry {
  task: string;
  model: string;
  fallback?: string;
  maxInrPerRun: number;
}

export interface AgentDefinition {
  id: string;
  version: string; // semver; bumped on prompt, model or tool change
  triggers: Trigger[];
  tools: string[]; // registry names, least privilege
  modelPolicy: ModelPolicyEntry[];
  defaultAutonomy: Record<string, AutonomyLevel>;
  evalDataset: string;
  description: string;
}

export const demoAgentDefinition: AgentDefinition = {
  id: "demo",
  version: "1.0.0",
  triggers: [{ kind: "event", event_type: "document.received" }],
  tools: [],
  modelPolicy: [
    { task: "classify", model: "mock", maxInrPerRun: 0.5 },
    { task: "extract", model: "mock", maxInrPerRun: 1.0 },
  ],
  defaultAutonomy: { "tally.post_purchase_voucher": 2 },
  evalDataset: "demo-smoke",
  description:
    "Demo agent proving the M0 exit criterion: one traced agent run end to end (reader → validator → proposer → policy decision → ledger).",
};

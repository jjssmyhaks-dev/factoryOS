import { z } from "zod";

/** §6.3 persisted action lifecycle states. */
export const ACTION_STATES = [
  "proposed",
  "policy_evaluated",
  "suggested_only",
  "pending_approval",
  "approved",
  "rejected",
  "expired",
  "auto_approved",
  "shadow_recorded",
  "executing",
  "executed",
  "reversed",
  "failed",
  "verify_failed",
] as const;
export type ActionState = (typeof ACTION_STATES)[number];

export const TERMINAL_STATES: readonly ActionState[] = [
  "suggested_only",
  "rejected",
  "expired",
  "shadow_recorded",
  "reversed",
  "failed",
  "verify_failed",
];

export function isTerminal(state: ActionState): boolean {
  return TERMINAL_STATES.includes(state);
}

export const evidenceSchema = z.object({
  kind: z.enum(["document_region", "row", "rate", "message", "trace"]),
  ref: z.string(),
  label: z.string().optional(),
});

export const proposedActionSchema = z.object({
  id: z.uuid(),
  tenant_id: z.uuid(),
  run_id: z.uuid().nullish(),
  action_type: z.string().min(3).max(80),
  payload: z.unknown(),
  payload_schema_version: z.string().min(1),
  summary: z.string().min(1),
  value_inr: z.number().nonnegative().nullish(),
  confidence: z.number().min(0).max(1).nullish(),
  flags: z.array(z.record(z.string(), z.unknown())).default([]),
  evidence: z.array(evidenceSchema).default([]),
  idempotency_key: z.string().min(1),
  state: z.enum(ACTION_STATES),
  decided_mode: z.enum(["suggest", "approve", "auto", "shadow"]).nullish(),
  decision_reason: z.unknown().nullish(),
  executed_at: z.date().nullish(),
  reversed_at: z.date().nullish(),
  created_at: z.date(),
});
export type ProposedAction = z.infer<typeof proposedActionSchema>;

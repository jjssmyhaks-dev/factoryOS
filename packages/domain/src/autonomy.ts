/**
 * Autonomy levels (PRD §6.1) and Appendix A defaults.
 * All numeric values are [HYPOTHESIS]: they MUST stay configurable per tenant
 * via `autonomy_policies`; these are only the shipped starting points.
 */

export type AutonomyLevel = 0 | 1 | 2 | 3 | 4;
// 0 suggest only, 1 draft, 2 act after approval, 3 act then notify, 4 autonomous within limits

export type SideEffect = "none" | "internal_write" | "external_write";
export type Risk = "low" | "medium" | "high";
export type PolicyMode = "suggest" | "draft" | "approve" | "auto" | "shadow" | "blocked";

export interface AutonomyDefault {
  actionType: string;
  sideEffect: SideEffect;
  risk: Risk;
  startLevel: AutonomyLevel;
  earnedMax: AutonomyLevel;
  /** null = no value threshold configured (approvals still follow the level). */
  valueThresholdInr: number | null;
  phase: 1 | 2;
  notes?: string;
}

/** Appendix A — Autonomy policy defaults. All values [HYPOTHESIS]. */
export const AUTONOMY_DEFAULTS: readonly AutonomyDefault[] = [
  { actionType: "extract.document", sideEffect: "none", risk: "low", startLevel: 3, earnedMax: 3, valueThresholdInr: null, phase: 1, notes: "Read-only, always allowed" },
  { actionType: "master.map_item_alias", sideEffect: "internal_write", risk: "low", startLevel: 2, earnedMax: 3, valueThresholdInr: null, phase: 1, notes: "Auto only when confidence ≥ 0.95 and confirmed before for this supplier" },
  { actionType: "master.create_party", sideEffect: "internal_write", risk: "medium", startLevel: 2, earnedMax: 2, valueThresholdInr: null, phase: 1, notes: "Always approved" },
  { actionType: "tally.post_purchase_voucher", sideEffect: "external_write", risk: "high", startLevel: 2, earnedMax: 3, valueThresholdInr: null, phase: 1, notes: "₹ threshold per tenant; level 3 only for suppliers with ≥ 20 clean approvals" },
  { actionType: "tally.post_receipt", sideEffect: "external_write", risk: "high", startLevel: 2, earnedMax: 2, valueThresholdInr: null, phase: 1, notes: "Approval always in Phase 1" },
  { actionType: "whatsapp.send_owner_brief", sideEffect: "external_write", risk: "low", startLevel: 2, earnedMax: 3, valueThresholdInr: null, phase: 1, notes: "Recipient is a verified internal user only; approval until earned trust" },
  { actionType: "whatsapp.send_reminder", sideEffect: "external_write", risk: "medium", startLevel: 2, earnedMax: 3, valueThresholdInr: null, phase: 1, notes: "Caps: 1 per party per week, quiet hours, opt-in required" },
  { actionType: "whatsapp.send_clarification", sideEffect: "external_write", risk: "low", startLevel: 2, earnedMax: 3, valueThresholdInr: null, phase: 1, notes: "Only to known parties and users" },
  { actionType: "quote.draft", sideEffect: "internal_write", risk: "low", startLevel: 3, earnedMax: 3, valueThresholdInr: null, phase: 1, notes: "Draft only" },
  { actionType: "quote.send", sideEffect: "external_write", risk: "high", startLevel: 2, earnedMax: 2, valueThresholdInr: null, phase: 1, notes: "Level 3 not available in Phase 1" },
  { actionType: "po.raise", sideEffect: "external_write", risk: "high", startLevel: 2, earnedMax: 3, valueThresholdInr: null, phase: 2, notes: "Approval above threshold always" },
  { actionType: "stock.reorder_suggest", sideEffect: "none", risk: "low", startLevel: 1, earnedMax: 1, valueThresholdInr: null, phase: 2, notes: "Suggestion only" },
];

export function autonomyDefault(actionType: string): AutonomyDefault | undefined {
  return AUTONOMY_DEFAULTS.find((d) => d.actionType === actionType);
}

export function levelToMode(level: AutonomyLevel): PolicyMode {
  switch (level) {
    case 0:
      return "suggest";
    case 1:
      return "draft";
    case 2:
      return "approve";
    case 3:
    case 4:
      return "auto";
  }
}

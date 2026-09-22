import {
  AUTONOMY_DEFAULTS,
  autonomyDefault,
  levelToMode,
  type AutonomyDefault,
  type AutonomyLevel,
  type PolicyMode,
} from "@factory/domain";

/**
 * §6.4 policy engine.
 *
 *   decide(proposal, tenantPolicy, agentStats, tenantFlags) -> { mode, reason }
 *
 *   effective_level = min(configured_level, earned_level, global_max_level)
 *   if tenant.autonomy_kill_switch          -> level capped at 2 (approve)
 *   if proposal.value_inr > threshold       -> approve
 *   if proposal.confidence < min_confidence -> approve
 *   if limits breached                      -> approve or blocked
 *   if agent in shadow for this action_type -> shadow
 *   level 0 -> suggest; 1 -> draft; 2 -> approve; 3 -> auto + notify; 4 -> auto within limits
 *
 * All numeric thresholds live in config / Appendix A defaults — [HYPOTHESIS].
 */

export interface PolicyProposal {
  action_type: string;
  value_inr?: number | null;
  confidence?: number | null;
}

export interface TenantActionPolicy {
  configured_level: AutonomyLevel;
  value_threshold_inr?: number | null;
  min_confidence?: number | null;
  limits?: {
    /** Hard cap: max outbound messages per party per week (Appendix A notes). */
    max_per_party_week?: number;
    /** Quiet hours in IST, e.g. { start: "21:00", end: "09:00" } (E5-S2 default). */
    quiet_hours?: { start: string; end: string };
  };
}

export interface AgentStatsWindow {
  samples: number;
  accuracy: number;
  override_rate: number;
  reversal_rate: number;
  sev1_incidents: number;
  window_days: number;
}

export interface TenantPolicyFlags {
  autonomy_kill_switch: boolean;
  shadow_action_types?: readonly string[];
  /** Global cap, default 4. */
  global_max_level?: AutonomyLevel;
}

export interface PolicyContext {
  /** false → hard block (E6-S8 outbound allowlist). undefined → not applicable. */
  recipient_allowlisted?: boolean;
  /** Messages already sent to this party in the current week. */
  party_week_count?: number;
  /** Defaults to now; inject for tests (quiet hours depend on IST). */
  now?: Date;
}

export interface PolicyDecision {
  mode: PolicyMode;
  effective_level: AutonomyLevel;
  reason: Record<string, unknown>;
}

/** [HYPOTHESIS] §6.4 earned-autonomy thresholds — configurable, not hard product truth. */
export const EARNED_THRESHOLDS = {
  level2: { minSamples: 30, minAccuracy: 0.95 },
  level3: { minSamples: 200, minAccuracy: 0.98, minOverrideRate: 0.03, minWindowDays: 30 },
} as const;

/**
 * Recomputes `earned_level` for (tenant, action_type) — nightly job (§6.4, E7-S2).
 *
 * Semantics chosen to reconcile Appendix A "start level" with §6.4 thresholds
 * (logged in docs/open-questions.md):
 * - No stats yet → the Appendix start level (granted at setup).
 * - A sev-1 incident resets to 1; re-earning level 2 requires the §6.4
 *   conditions (≥30 samples, ≥95% accuracy) — satisfied in shadow or approval
 *   mode, which is where those samples accrue.
 * - Sustained accuracy below 95% over ≥30 samples demotes to 1.
 * - Promotion above start level requires the level-3 conditions.
 * - Capped by `earnedMax` (Appendix A); level 4 is never earned for
 *   external_write in Phase 1 because no Appendix entry grants earnedMax 4.
 */
export function computeEarnedLevel(
  stats: AgentStatsWindow | null | undefined,
  def: AutonomyDefault | undefined,
): AutonomyLevel {
  if (!def) return 1;
  if (!stats) return def.startLevel;
  if (stats.sev1_incidents > 0) return 1;

  let level: number = def.startLevel;

  if (stats.samples >= EARNED_THRESHOLDS.level2.minSamples) {
    if (stats.accuracy < EARNED_THRESHOLDS.level2.minAccuracy) {
      level = 1;
    } else if (level < 2) {
      level = 2; // re-earned after a reset
    }
  }

  const l3 = EARNED_THRESHOLDS.level3;
  if (
    level >= 2 &&
    def.earnedMax >= 3 &&
    stats.samples >= l3.minSamples &&
    stats.window_days >= l3.minWindowDays &&
    stats.accuracy >= l3.minAccuracy &&
    stats.override_rate <= l3.minOverrideRate
  ) {
    level = 3;
  }

  return Math.min(level, def.earnedMax) as AutonomyLevel;
}

const AUTONOMY_RANK: Record<PolicyMode, number> = {
  suggest: 0,
  draft: 1,
  approve: 2,
  auto: 3,
  shadow: 90,
  blocked: 99,
};

/** A safety trigger may only move a mode *towards* human control, never away. */
function saferOf(a: PolicyMode, b: PolicyMode): PolicyMode {
  return AUTONOMY_RANK[a] <= AUTONOMY_RANK[b] ? a : b;
}

function parseHm(hm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm);
  if (!m) throw new Error(`invalid HH:MM: ${hm}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`invalid HH:MM: ${hm}`);
  return h * 60 + min;
}

/** Current hour:minute in IST (Asia/Kolkata) for quiet-hours checks. */
export function istMinutes(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return (hour % 24) * 60 + minute;
}

export function quietHoursActive(now: Date, window: { start: string; end: string }): boolean {
  const start = parseHm(window.start);
  const end = parseHm(window.end);
  const nowMin = istMinutes(now);
  if (start === end) return false;
  return start < end ? nowMin >= start && nowMin < end : nowMin >= start || nowMin < end;
}

export function decide(
  proposal: PolicyProposal,
  tenantPolicy: TenantActionPolicy,
  agentStats: AgentStatsWindow | null | undefined,
  tenantFlags: TenantPolicyFlags,
  context: PolicyContext = {},
): PolicyDecision {
  const def = autonomyDefault(proposal.action_type);
  const unknownAction = !def;
  // Unknown action types are treated as worst case: suggest-only.
  const sideEffect = def?.sideEffect ?? "external_write";
  const globalMax = tenantFlags.global_max_level ?? 4;

  const configured = unknownAction ? 0 : tenantPolicy.configured_level;
  const earned = computeEarnedLevel(agentStats, def);

  // Read-only actions are not gated by earned autonomy (Appendix A:
  // "Read-only, always allowed") — but the kill switch still caps them (§6.4).
  let level: number =
    sideEffect === "none" ? Math.min(configured, globalMax) : Math.min(configured, earned, globalMax);

  const killSwitch = tenantFlags.autonomy_kill_switch === true;
  if (killSwitch) level = Math.min(level, 2);

  let mode = levelToMode(level as AutonomyLevel);

  const reason: Record<string, unknown> = {
    configured_level: configured,
    earned_level: earned,
    global_max_level: globalMax,
    effective_level: level,
    kill_switch: killSwitch,
    side_effect: sideEffect,
  };
  if (unknownAction) reason["unknown_action_type"] = true;

  // Value threshold → human review.
  const threshold = tenantPolicy.value_threshold_inr;
  if (proposal.value_inr != null && threshold != null && proposal.value_inr > threshold) {
    mode = saferOf(mode, "approve");
    reason["value_threshold_breached"] = true;
  }

  // Confidence floor → human review.
  const minConf = tenantPolicy.min_confidence;
  if (proposal.confidence != null && minConf != null && proposal.confidence < minConf) {
    mode = saferOf(mode, "approve");
    reason["confidence_below_min"] = true;
  }

  // Limits (§6.4): rate caps and allowlist are hard blocks; quiet hours
  // downgrade to approve with a defer flag — the executor holds the send until
  // the window opens (choice logged in docs/open-questions.md).
  const breaches: string[] = [];
  let hardBlock = false;
  if (context.recipient_allowlisted === false) {
    breaches.push("recipient_not_allowlisted");
    hardBlock = true;
  }
  const cap = tenantPolicy.limits?.max_per_party_week;
  if (cap != null && context.party_week_count != null && context.party_week_count >= cap) {
    breaches.push("rate_cap");
    hardBlock = true;
  }
  const qh = tenantPolicy.limits?.quiet_hours;
  const now = context.now ?? new Date();
  if (qh && quietHoursActive(now, qh)) {
    breaches.push("quiet_hours");
    reason["defer_until_quiet_hours_end"] = qh.end;
  }
  if (breaches.length > 0) reason["limits_breached"] = breaches;
  if (hardBlock) {
    mode = "blocked";
  } else if (breaches.length > 0) {
    mode = saferOf(mode, "approve");
  }

  // Shadow mode (§6.6) wins last: nothing executes, the proposal is recorded
  // and scored against later human action.
  if ((tenantFlags.shadow_action_types ?? []).includes(proposal.action_type)) {
    mode = "shadow";
    reason["shadow"] = true;
  }

  reason["final_mode"] = mode;
  return { mode, effective_level: level as AutonomyLevel, reason };
}

/** Exported for table tests generated from Appendix A. */
export const APPENDIX_A = AUTONOMY_DEFAULTS;
export { autonomyDefault };

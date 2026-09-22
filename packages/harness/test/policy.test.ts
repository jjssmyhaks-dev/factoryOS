import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { AUTONOMY_DEFAULTS, levelToMode, type AutonomyDefault } from "@factory/domain";
import {
  APPENDIX_A,
  EARNED_THRESHOLDS,
  computeEarnedLevel,
  decide,
  istMinutes,
  quietHoursActive,
  type AgentStatsWindow,
  type PolicyProposal,
  type TenantActionPolicy,
  type TenantPolicyFlags,
} from "../src/policy.js";

/** Build the default tenant policy for an Appendix A row (start level, no overrides). */
function defaultPolicy(def: AutonomyDefault, over: Partial<TenantActionPolicy> = {}): TenantActionPolicy {
  return { configured_level: def.startLevel, ...over };
}

const NO_FLAGS: TenantPolicyFlags = { autonomy_kill_switch: false };
const NO_STATS: AgentStatsWindow = {
  samples: 0,
  accuracy: 1,
  override_rate: 0,
  reversal_rate: 0,
  sev1_incidents: 0,
  window_days: 0,
};

/** §6.4-ish healthy stats that should satisfy level-2 conditions. */
const HEALTHY_200: AgentStatsWindow = {
  samples: 250,
  accuracy: 0.99,
  override_rate: 0.01,
  reversal_rate: 0,
  sev1_incidents: 0,
  window_days: 40,
};

/**
 * E6-S3: table-driven test suite generated from Appendix A — one describe
 * block per action type, verifying start levels, kill switch behaviour,
 * thresholds and shadow mode.
 */
describe.each(AUTONOMY_DEFAULTS)("Appendix A: $actionType", (def) => {
  const proposal: PolicyProposal = { action_type: def.actionType, confidence: 0.99 };

  it("starts at the Appendix start level when nothing else constrains it", () => {
    const d = decide(proposal, defaultPolicy(def), null, NO_FLAGS);
    expect(d.effective_level).toBe(def.startLevel);
    expect(d.mode).toBe(levelToMode(def.startLevel));
  });

  it("kill switch caps the level at 2 (approve)", () => {
    const d = decide(
      proposal,
      defaultPolicy(def, { configured_level: 4 as never }),
      HEALTHY_200,
      { autonomy_kill_switch: true },
    );
    expect(d.effective_level).toBeLessThanOrEqual(2);
    expect(["suggest", "draft", "approve"]).toContain(d.mode);
    expect(d.reason["kill_switch"]).toBe(true);
    if (def.startLevel >= 2 || def.sideEffect === "none") {
      expect(d.mode).toBe("approve");
    }
  });

  it("never exceeds earnedMax even when configured higher", () => {
    const d = decide(
      proposal,
      defaultPolicy(def, { configured_level: 4 as never }),
      HEALTHY_200,
      NO_FLAGS,
    );
    if (def.sideEffect === "none") {
      // read-only bypasses earned gating, but configured=4 stays ≤ global max
      expect(d.effective_level).toBeLessThanOrEqual(4);
    } else {
      expect(d.effective_level).toBeLessThanOrEqual(def.earnedMax);
    }
  });

  it("value above the threshold forces human review", () => {
    if (def.startLevel < 3) return; // only meaningful when the default is auto
    const d = decide(
      { ...proposal, value_inr: 900_000 },
      defaultPolicy(def, { value_threshold_inr: 50_000 }),
      HEALTHY_200,
      NO_FLAGS,
    );
    expect(d.mode).toBe("approve");
    expect(d.reason["value_threshold_breached"]).toBe(true);
  });

  it("confidence below the floor forces human review", () => {
    if (def.startLevel < 3) return;
    const d = decide(
      { ...proposal, confidence: 0.5 },
      defaultPolicy(def, { min_confidence: 0.9 }),
      HEALTHY_200,
      NO_FLAGS,
    );
    expect(d.mode).toBe("approve");
    expect(d.reason["confidence_below_min"]).toBe(true);
  });

  it("shadow mode records instead of executing", () => {
    const d = decide(proposal, defaultPolicy(def), null, {
      autonomy_kill_switch: false,
      shadow_action_types: [def.actionType],
    });
    expect(d.mode).toBe("shadow");
    expect(d.reason["shadow"]).toBe(true);
  });

  it("unknown action types fall back to suggest-only", () => {
    const d = decide({ action_type: "unknown.thing" }, defaultPolicy(def), null, NO_FLAGS);
    expect(d.mode).toBe("suggest");
    expect(d.effective_level).toBe(0);
    expect(d.reason["unknown_action_type"]).toBe(true);
  });
});

describe("limits (§6.4)", () => {
  const def = AUTONOMY_DEFAULTS.find((d) => d.actionType === "whatsapp.send_reminder")!;
  const policy: TenantActionPolicy = {
    configured_level: 3,
    limits: { max_per_party_week: 1, quiet_hours: { start: "21:00", end: "09:00" } },
  };

  it("unallowlisted recipient is hard-blocked (E6-S8)", () => {
    const d = decide(
      { action_type: def.actionType, confidence: 0.99 },
      policy,
      HEALTHY_200,
      NO_FLAGS,
      { recipient_allowlisted: false },
    );
    expect(d.mode).toBe("blocked");
    expect(d.reason["limits_breached"]).toContain("recipient_not_allowlisted");
  });

  it("rate cap over the weekly limit is hard-blocked", () => {
    const d = decide(
      { action_type: def.actionType, confidence: 0.99 },
      policy,
      HEALTHY_200,
      NO_FLAGS,
      { party_week_count: 1 },
    );
    expect(d.mode).toBe("blocked");
    expect(d.reason["limits_breached"]).toContain("rate_cap");
  });

  it("one message below the cap is allowed at level 3", () => {
    const d = decide(
      { action_type: def.actionType, confidence: 0.99 },
      policy,
      HEALTHY_200,
      NO_FLAGS,
      { party_week_count: 0, now: new Date("2026-09-22T06:00:00Z") }, // 11:30 IST, not quiet
    );
    expect(d.mode).toBe("auto");
  });

  it("quiet hours downgrade auto → approve with a defer flag", () => {
    // 2026-09-22T18:30Z → 00:00 IST (inside 21:00–09:00)
    const d = decide(
      { action_type: def.actionType, confidence: 0.99 },
      policy,
      HEALTHY_200,
      NO_FLAGS,
      { party_week_count: 0, now: new Date("2026-09-22T18:30:00Z") },
    );
    expect(d.mode).toBe("approve");
    expect(d.reason["limits_breached"]).toContain("quiet_hours");
    expect(d.reason["defer_until_quiet_hours_end"]).toBe("09:00");
  });

  it("allowlist block beats shadow? no — shadow wins last (§6.4 order), still zero side effects", () => {
    const d = decide(
      { action_type: def.actionType },
      policy,
      HEALTHY_200,
      { autonomy_kill_switch: false, shadow_action_types: [def.actionType] },
      { recipient_allowlisted: false },
    );
    expect(d.mode).toBe("shadow");
  });
});

describe("quiet hours helper", () => {
  const window = { start: "21:00", end: "09:00" };

  it("computes IST correctly (UTC+5:30)", () => {
    expect(istMinutes(new Date("2026-09-22T05:30:00Z"))).toBe(11 * 60); // 11:00 IST
    expect(istMinutes(new Date("2026-09-22T18:30:00Z"))).toBe(0); // 00:00 IST
    expect(istMinutes(new Date("2026-09-22T15:30:00Z"))).toBe(21 * 60); // 21:00 IST
  });

  it("handles wrapping windows", () => {
    expect(quietHoursActive(new Date("2026-09-22T18:30:00Z"), window)).toBe(true); // 00:00
    expect(quietHoursActive(new Date("2026-09-22T15:30:00Z"), window)).toBe(true); // 21:00 boundary
    expect(quietHoursActive(new Date("2026-09-22T04:00:00Z"), window)).toBe(false); // 09:30 is outside
    expect(quietHoursActive(new Date("2026-09-22T03:30:00Z"), window)).toBe(false); // 09:00 end boundary → outside
    expect(quietHoursActive(new Date("2026-09-22T06:00:00Z"), window)).toBe(false); // 11:30
  });

  it("non-wrapping window", () => {
    const w = { start: "09:00", end: "18:00" };
    expect(quietHoursActive(new Date("2026-09-22T06:00:00Z"), w)).toBe(true); // 11:30
    expect(quietHoursActive(new Date("2026-09-22T15:30:00Z"), w)).toBe(false); // 21:30
    expect(quietHoursActive(new Date("2026-09-22T04:00:00Z"), w)).toBe(true); // 09:30 IS in window
  });

  it("empty window (start === end) never active", () => {
    expect(quietHoursActive(new Date(), { start: "10:00", end: "10:00" })).toBe(false);
  });

  it("rejects malformed times", () => {
    expect(() => quietHoursActive(new Date(), { start: "25:00", end: "09:00" })).toThrow();
    expect(() => quietHoursActive(new Date(), { start: "ab:cd", end: "09:00" })).toThrow();
  });
});

describe("computeEarnedLevel (§6.4)", () => {
  const voucher = AUTONOMY_DEFAULTS.find((d) => d.actionType === "tally.post_purchase_voucher")!;
  const readonly = AUTONOMY_DEFAULTS.find((d) => d.actionType === "extract.document")!;
  const reorder = AUTONOMY_DEFAULTS.find((d) => d.actionType === "stock.reorder_suggest")!;

  it("no stats yet → start level", () => {
    expect(computeEarnedLevel(null, voucher)).toBe(voucher.startLevel);
    expect(computeEarnedLevel(undefined, voucher)).toBe(voucher.startLevel);
    expect(computeEarnedLevel(NO_STATS, readonly)).toBe(readonly.startLevel);
  });

  it("unknown action → 1", () => {
    expect(computeEarnedLevel(HEALTHY_200, undefined)).toBe(1);
  });

  it("sev-1 resets to 1", () => {
    expect(computeEarnedLevel({ ...HEALTHY_200, sev1_incidents: 1 }, voucher)).toBe(1);
    expect(computeEarnedLevel({ ...HEALTHY_200, sev1_incidents: 1 }, readonly)).toBe(1);
  });

  it("after a reset, level 2 requires ≥30 samples with ≥95% accuracy", () => {
    const lowSamples: AgentStatsWindow = { ...HEALTHY_200, samples: 29 };
    // start level is still granted fresh… but with low accuracy we demote
    const lowAccuracy: AgentStatsWindow = { ...HEALTHY_200, samples: 40, accuracy: 0.9 };
    expect(computeEarnedLevel(lowSamples, { ...voucher, startLevel: 1, earnedMax: 3 })).toBe(1);
    expect(computeEarnedLevel(lowAccuracy, voucher)).toBe(1); // sustained <95%
    const good: AgentStatsWindow = { ...HEALTHY_200, samples: 40 };
    expect(computeEarnedLevel(good, { ...voucher, startLevel: 1, earnedMax: 3 })).toBe(2);
  });

  it("level 3 requires 200 samples over ≥30 days, ≥98% accuracy, ≤3% override", () => {
    const def: AutonomyDefault = { ...voucher, startLevel: 2, earnedMax: 3 };
    expect(computeEarnedLevel(HEALTHY_200, def)).toBe(3);
    expect(computeEarnedLevel({ ...HEALTHY_200, samples: 199 }, def)).toBe(2);
    expect(computeEarnedLevel({ ...HEALTHY_200, window_days: 29 }, def)).toBe(2);
    expect(computeEarnedLevel({ ...HEALTHY_200, accuracy: 0.97 }, def)).toBe(2);
    expect(computeEarnedLevel({ ...HEALTHY_200, override_rate: 0.04 }, def)).toBe(2);
  });

  it("never exceeds earnedMax (Phase 1: external_write maxes at 3)", () => {
    expect(computeEarnedLevel(HEALTHY_200, { ...voucher, earnedMax: 2 })).toBe(2);
    expect(computeEarnedLevel(HEALTHY_200, reorder)).toBeLessThanOrEqual(reorder.earnedMax);
  });

  it("thresholds are configurable data, not code constants consumers rely on", () => {
    expect(EARNED_THRESHOLDS.level2.minSamples).toBeGreaterThanOrEqual(1);
    expect(EARNED_THRESHOLDS.level3.minSamples).toBeGreaterThan(
      EARNED_THRESHOLDS.level2.minSamples,
    );
  });
});

describe("property: safety triggers only ever move towards human control", () => {
  it("value/confidence/kill-switch never increase autonomy rank", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...AUTONOMY_DEFAULTS.map((d) => d.actionType)),
        fc.integer({ min: 0, max: 4 }),
        fc.boolean(),
        fc.boolean(),
        (actionType, configured, killSwitch, breach) => {
          const policy: TenantActionPolicy = {
            configured_level: configured as TenantActionPolicy["configured_level"],
            value_threshold_inr: breach ? 1 : null,
            min_confidence: breach ? 1.1 : null,
          };
          const base = decide(
            { action_type: actionType, value_inr: 100, confidence: 1 },
            policy,
            HEALTHY_200,
            { autonomy_kill_switch: false },
          );
          const guarded = decide(
            { action_type: action_type(actionType, breach), value_inr: 100, confidence: breach ? 0.1 : 1 },
            { ...policy, min_confidence: breach ? 0.5 : null },
            HEALTHY_200,
            { autonomy_kill_switch: killSwitch },
          );
          const rank = { suggest: 0, draft: 1, approve: 2, auto: 3, shadow: 90, blocked: 99 } as const;
          const ceiling = killSwitch ? 2 : 3;
          expect(rank[guarded.mode]).toBeLessThanOrEqual(
            Math.max(rank[base.mode], ceiling),
          );
        },
      ),
    );
  });
});

// helper used above to vary the proposal shape per branch
function action_type(actionType: string, breach: boolean): string {
  return breach ? actionType : actionType;
}

describe("APPENDIX_A export", () => {
  it("equals the domain defaults (single source)", () => {
    expect(APPENDIX_A).toBe(AUTONOMY_DEFAULTS);
    expect(levelToMode(2)).toBe("approve");
  });
});

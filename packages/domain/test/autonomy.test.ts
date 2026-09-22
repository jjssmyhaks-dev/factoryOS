import { describe, expect, it } from "vitest";
import { AUTONOMY_DEFAULTS, autonomyDefault, levelToMode } from "../src/autonomy.js";

describe("Appendix A defaults", () => {
  it("contain no duplicate action types", () => {
    const seen = new Set<string>();
    for (const d of AUTONOMY_DEFAULTS) {
      expect(seen.has(d.actionType), `duplicate: ${d.actionType}`).toBe(false);
      seen.add(d.actionType);
    }
  });

  it("startLevel ≤ earnedMax ≤ 4 for every entry", () => {
    for (const d of AUTONOMY_DEFAULTS) {
      expect(d.startLevel, d.actionType).toBeGreaterThanOrEqual(0);
      expect(d.earnedMax, d.actionType).toBeGreaterThanOrEqual(d.startLevel);
      expect(d.earnedMax, d.actionType).toBeLessThanOrEqual(4);
    }
  });

  it("external_write actions start at level ≤ 2 (trust before autonomy)", () => {
    for (const d of AUTONOMY_DEFAULTS) {
      if (d.sideEffect === "external_write") {
        expect(d.startLevel, d.actionType).toBeLessThanOrEqual(2);
      }
    }
  });

  it("level 4 is never the earned max of an external_write action in Phase 1 (§6.4)", () => {
    for (const d of AUTONOMY_DEFAULTS) {
      if (d.sideEffect === "external_write" && d.phase === 1) {
        expect(d.earnedMax, d.actionType).toBeLessThan(4);
      }
    }
  });

  it("maps levels to modes per §6.1", () => {
    expect(levelToMode(0)).toBe("suggest");
    expect(levelToMode(1)).toBe("draft");
    expect(levelToMode(2)).toBe("approve");
    expect(levelToMode(3)).toBe("auto");
    expect(levelToMode(4)).toBe("auto");
  });

  it("autonomyDefault finds entries and rejects unknown types", () => {
    expect(autonomyDefault("quote.send")?.risk).toBe("high");
    expect(autonomyDefault("nope.nope")).toBeUndefined();
  });
});

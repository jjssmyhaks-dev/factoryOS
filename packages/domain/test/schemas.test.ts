import { describe, expect, it } from "vitest";
import { formatINR, parseINR, roundPaisa } from "../src/money.js";
import { isValidGstinFormat, panFromGstin, stateCodeFromGstin } from "../src/gstin.js";
import { isTerminal, proposedActionSchema, ACTION_STATES } from "../src/action.js";
import { membershipSchema, tenantSchema } from "../src/tenant.js";

describe("formatINR", () => {
  it("groups in the Indian system", () => {
    expect(formatINR(1234567.5)).toBe("₹12,34,567.50");
    expect(formatINR(999)).toBe("₹999.00");
    expect(formatINR(1000)).toBe("₹1,000.00");
    expect(formatINR(-250000)).toBe("-₹2,50,000.00");
  });

  it("can omit the symbol", () => {
    expect(formatINR(1000, { symbol: false })).toBe("1,000.00");
  });

  it("rejects non-finite input", () => {
    expect(() => formatINR(Number.NaN)).toThrow();
    expect(() => formatINR(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("parseINR", () => {
  it("round-trips formatted values", () => {
    expect(parseINR("₹12,34,567.50")).toBe(1234567.5);
    expect(parseINR("1234567.5")).toBe(1234567.5);
    expect(parseINR("-2,500")).toBe(-2500);
  });

  it("throws on garbage", () => {
    expect(() => parseINR("abc")).toThrow();
    expect(() => parseINR("₹12..3")).toThrow();
    expect(() => parseINR("")).toThrow();
  });
});

describe("roundPaisa", () => {
  it("rounds half away from zero to 2dp", () => {
    expect(roundPaisa(1.005)).toBe(1.01);
    expect(roundPaisa(-1.005)).toBe(-1.01);
    expect(roundPaisa(2.675)).toBe(2.68);
    expect(roundPaisa(10)).toBe(10);
  });
});

describe("GSTIN helpers", () => {
  it("validates format and state code", () => {
    expect(isValidGstinFormat("24AAACN1234A1Z5")).toBe(true);
    expect(isValidGstinFormat("24AAACN1234A1Z")).toBe(false);
    expect(isValidGstinFormat("00AAACN1234A1Z5")).toBe(false); // 00 is not a real state code
    expect(isValidGstinFormat("xxAAACN1234A1Z5")).toBe(false);
  });

  it("extracts state code and PAN", () => {
    expect(stateCodeFromGstin("24AAACN1234A1Z5")).toBe("24");
    expect(panFromGstin("24AAACN1234A1Z5")).toBe("AAACN1234A");
    expect(stateCodeFromGstin("bad")).toBeNull();
    expect(panFromGstin("bad")).toBeNull();
  });
});

describe("action states", () => {
  it("terminal set is a subset of ACTION_STATES", () => {
    for (const s of ["suggested_only", "rejected", "expired", "shadow_recorded", "reversed", "failed", "verify_failed"] as const) {
      expect(ACTION_STATES).toContain(s);
      expect(isTerminal(s)).toBe(true);
    }
    expect(isTerminal("executing")).toBe(false);
    expect(isTerminal("proposed")).toBe(false);
  });

  it("proposedActionSchema enforces invariants", () => {
    const base = {
      id: "2b0f9c9e-1111-4222-8333-444455556666",
      tenant_id: "2b0f9c9e-1111-4222-8333-444455557777",
      action_type: "tally.post_purchase_voucher",
      payload: { a: 1 },
      payload_schema_version: "1",
      summary: "Post voucher for ABC",
      idempotency_key: "k1",
      state: "proposed",
      created_at: new Date(),
    };
    expect(proposedActionSchema.safeParse(base).success).toBe(true);

    const badConfidence = { ...base, confidence: 1.5 };
    expect(proposedActionSchema.safeParse(badConfidence).success).toBe(false);

    const badState = { ...base, state: "not_a_state" };
    expect(proposedActionSchema.safeParse(badState).success).toBe(false);

    const negativeValue = { ...base, value_inr: -1 };
    expect(proposedActionSchema.safeParse(negativeValue).success).toBe(false);
  });
});

describe("tenant and membership schemas", () => {
  it("accepts a valid tenant", () => {
    const t = {
      id: "2b0f9c9e-1111-4222-8333-444455558888",
      name: "Sharma Fabrics",
      created_at: new Date(),
    };
    const parsed = tenantSchema.parse(t);
    expect(parsed.plan).toBe("free");
    expect(parsed.autonomy_kill_switch).toBe(false);
  });

  it("accepts a valid membership with E.164 phone", () => {
    const m = {
      tenant_id: "2b0f9c9e-1111-4222-8333-444455558888",
      user_id: "2b0f9c9e-1111-4222-8333-444455559999",
      role: "owner",
      phone_e164: "+919876543210",
    };
    const parsed = membershipSchema.parse(m);
    expect(parsed.language).toBe("en");
  });

  it("rejects a bad phone or unknown role", () => {
    const base = {
      tenant_id: "2b0f9c9e-1111-4222-8333-444455558888",
      user_id: "2b0f9c9e-1111-4222-8333-444455559999",
    };
    expect(
      membershipSchema.safeParse({ ...base, role: "owner", phone_e164: "9876543210" }).success,
    ).toBe(false);
    expect(membershipSchema.safeParse({ ...base, role: "superuser" }).success).toBe(false);
  });
});

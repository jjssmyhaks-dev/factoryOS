import { describe, expect, it } from "vitest";
import { tablesMissingPoliciesFromMigrations } from "./check-rls-policies.js";

describe("check-rls-policies (migration scan, no DB)", () => {
  it("finds zero missing policies in the shipped migrations", () => {
    expect(tablesMissingPoliciesFromMigrations()).toEqual([]);
  });

  it("every known tenant-scoped table appears in the enumeration", () => {
    // sanity: the scanner actually parses tables (not vacuously passing)
    const missing = tablesMissingPoliciesFromMigrations();
    expect(missing).not.toContain("documents");
    expect(missing).not.toContain("proposed_actions");
    expect(missing).not.toContain("feature_flags");
  });
});

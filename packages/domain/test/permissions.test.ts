import { describe, expect, it } from "vitest";
import {
  ROLES,
  approvableActionTypes,
  canApprove,
  canEditAutonomy,
  canManageConnections,
  canSeeMargins,
  canInviteMembers,
  canView,
  type Role,
} from "../src/permissions.js";

/**
 * Table-driven tests over docs/permissions-matrix.md — E1-S4 requires a test
 * per role for every capability.
 */

const ALL_ACTIONS = [
  "extract.document",
  "master.create_party",
  "tally.post_purchase_voucher",
  "tally.post_receipt",
  "quote.send",
  "whatsapp.send_reminder",
];

// Expected canApprove per role, transcribed from docs/permissions-matrix.md.
const EXPECTED_APPROVE: Record<Role, string[]> = {
  owner: [...ALL_ACTIONS],
  admin: [...ALL_ACTIONS],
  purchase: ["extract.document", "master.create_party", "whatsapp.send_reminder"],
  sales: ["extract.document", "master.create_party", "quote.send", "whatsapp.send_reminder"],
  accounts: [
    "extract.document",
    "master.create_party",
    "tally.post_purchase_voucher",
    "tally.post_receipt",
    "whatsapp.send_reminder",
  ],
  production: ["extract.document", "master.create_party"],
  operator: [],
  viewer: [],
};

describe("E1-S4 permission matrix", () => {
  for (const role of ROLES) {
    const expected = EXPECTED_APPROVE[role];
    describe(`role=${role}`, () => {
      it("approves exactly the actions in the matrix", () => {
        for (const action of ALL_ACTIONS) {
          expect(canApprove(role, action), `${role} -> ${action}`).toBe(
            expected.includes(action),
          );
        }
      });

      it("can view console data", () => {
        expect(canView(role)).toBe(true);
      });

      it("margins visible only to owner/accounts", () => {
        expect(canSeeMargins(role)).toBe(role === "owner" || role === "accounts");
      });

      it("autonomy settings editable only by owner", () => {
        expect(canEditAutonomy(role)).toBe(role === "owner");
      });

      it("connections managed by owner/admin", () => {
        expect(canManageConnections(role)).toBe(role === "owner" || role === "admin");
      });

      it("member invites by owner/admin", () => {
        expect(canInviteMembers(role)).toBe(role === "owner" || role === "admin");
      });
    });
  }

  it("operator and viewer approve nothing", () => {
    expect(approvableActionTypes("operator", ALL_ACTIONS)).toEqual([]);
    expect(approvableActionTypes("viewer", ALL_ACTIONS)).toEqual([]);
  });

  it("accounts can approve both tally vouchers", () => {
    const list = approvableActionTypes("accounts", ALL_ACTIONS);
    expect(list).toContain("tally.post_purchase_voucher");
    expect(list).toContain("tally.post_receipt");
  });
});

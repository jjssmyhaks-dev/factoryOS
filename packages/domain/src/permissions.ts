/**
 * E1-S4 permission matrix (PRD §10, docs/permissions-matrix.md).
 * Data, not scattered ifs: API middleware and the semantic layer call these.
 * Roles come from `memberships.role`.
 */

export const ROLES = [
  "owner",
  "admin",
  "purchase",
  "sales",
  "accounts",
  "production",
  "operator",
  "viewer",
] as const;
export type Role = (typeof ROLES)[number];

/** Action types with an explicitly restricted approver set (Appendix A). */
const RESTRICTED_APPROVERS: Record<string, readonly Role[]> = {
  "tally.post_purchase_voucher": ["owner", "admin", "accounts"],
  "tally.post_receipt": ["owner", "admin", "accounts"],
  "quote.send": ["owner", "admin", "sales"],
  "whatsapp.send_reminder": ["owner", "admin", "purchase", "sales", "accounts"],
};

/** Default approver set for action types not explicitly restricted. */
const DEFAULT_APPROVERS: readonly Role[] = [
  "owner",
  "admin",
  "purchase",
  "sales",
  "accounts",
  "production",
];

/** Roles that may approve *any* action type (the "default set" plus restricted). */
export function canApprove(role: Role, actionType: string): boolean {
  const allowed = RESTRICTED_APPROVERS[actionType] ?? DEFAULT_APPROVERS;
  return allowed.includes(role);
}

/** Action types a role may approve, for inbox filtering. */
export function approvableActionTypes(role: Role, allActionTypes: string[]): string[] {
  return allActionTypes.filter((t) => canApprove(role, t));
}

/** Margins and cost data: owner and accounts only (E1-S4 example). */
export function canSeeMargins(role: Role): boolean {
  return role === "owner" || role === "accounts";
}

export function canEditAutonomy(role: Role): boolean {
  return role === "owner";
}

export function canManageConnections(role: Role): boolean {
  return role === "owner" || role === "admin";
}

export function canInviteMembers(role: Role): boolean {
  return role === "owner" || role === "admin";
}

/** Read access to console data — every role in the matrix, viewer included. */
export function canView(_role: Role): boolean {
  return true;
}

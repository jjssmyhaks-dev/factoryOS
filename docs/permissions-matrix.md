# Permission matrix (E1-S4, PRD §1.5 / §10-S4)

Enforced in API middleware (`services/api/src/auth/permissions.ts`) and re-checked in the semantic layer. Roles come from `memberships.role`.

| Capability | owner | admin | purchase | sales | accounts | production | operator | viewer |
|---|---|---|---|---|---|---|---|---|
| View dashboards / briefs | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Approve actions (default set) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | |
| Approve `tally.post_*` vouchers | ✓ | ✓ | | | ✓ | | | |
| Approve `quote.send` | ✓ | ✓ | | ✓ | | | | |
| Approve `whatsapp.send_reminder` | ✓ | ✓ | ✓ | ✓ | ✓ | | | |
| Edit autonomy settings / kill switch | ✓ | | | | | | | |
| See margins and cost data | ✓ | | | | ✓ | | | |
| Manage connections & credentials | ✓ | ✓ | | | | | | |
| Invite / remove members | ✓ | ✓ | | | | | | |
| Create parties, items, POs | ✓ | ✓ | ✓ | ✓ | | | | |
| Log production / job status | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| Ops console impersonation (internal) | internal `ops` principal, time-boxed, audited (E13-S1) | | | | | | | |

Notes:

- `viewer` is read-only everywhere.
- Margin visibility is enforced in the semantic layer (`packages/semantic`, E10) and on document payloads (E12): only `owner` and `accounts` receive margin/cost fields.
- The matrix is data, not scattered `if`s: `packages/domain/src/permissions.ts` exports `canApprove(role, actionType)` and `canSeeMargins(role)`; API routes call them and tests cover every role × capability cell (E1-S4 "tests per role").

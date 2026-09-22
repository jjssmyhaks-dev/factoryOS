# Open questions

Append entries when an agent encounters ambiguity (PRD §0 working rule 2). Each entry: question, proposed default (already in use), flag for founder review.

| # | Question | Proposed default (in use) | Added by | Status |
|---|---|---|---|---|
| Q12 | Embedding dimension for `item_aliases.vector(N)` — model not yet chosen (PRD §4.2 **[VERIFY]**). | `vector(1536)`; swap after the embedding spike, requires a migration. | M0 scaffold | open |
| Q13 | Supabase Auth verifies RS256/ES256 JWTs via JWKS. M0 implements a pluggable verifier with HS256 for dev/test and JWKS fetch for production; confirm claim mapping (`sub`, `tenant_id` custom claim vs membership lookup). | Membership lookup by `sub` from `memberships` table; `x-tenant-id` header selects the active tenant. | M0 scaffold | open |
| Q14 | OTP delivery for phone linking is stubbed behind an `OtpSender` interface until the WhatsApp channel (E5) lands; which provider for interim email OTP? | Supabase's built-in email OTP. | M0 scaffold | open |
| Q15 | `agent_steps.input_ref/output_ref` payloads > 100 KB should go to S3 (PRD §4.3 payload rules). Threshold for the offload? | Offload to S3 when serialized size > 64 KB; store only the S3 key in Postgres. | M0 scaffold | open |
| Q16 | Step Functions execution-name reuse window after deletion is [VERIFY]; our idempotent guard also uses the Postgres unique constraint, so behavior on reuse must be tested against the real service before E6-S2 exit. | Keep the Postgres unique constraint as the final guard regardless. | M0 scaffold | open |

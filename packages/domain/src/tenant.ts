import { z } from "zod";

export const roleSchema = z.enum([
  "owner",
  "admin",
  "purchase",
  "sales",
  "accounts",
  "production",
  "operator",
  "viewer",
]);

export const tenantSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(200),
  gstin: z
    .string()
    .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z][Z][0-9A-Z]$/)
    .nullish(),
  state_code: z.string().length(2).nullish(),
  plan: z.enum(["free", "copilot", "operations", "factory_intelligence", "enterprise"]).default("free"),
  autonomy_kill_switch: z.boolean().default(false),
  settings: z.record(z.string(), z.unknown()).default({}),
  created_at: z.date(),
});
export type Tenant = z.infer<typeof tenantSchema>;

export const membershipSchema = z.object({
  tenant_id: z.uuid(),
  user_id: z.uuid(),
  role: roleSchema,
  phone_e164: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/)
    .nullish(),
  phone_verified_at: z.date().nullish(),
  language: z.enum(["en", "hi", "gu", "mr", "ta"]).default("en"),
});
export type Membership = z.infer<typeof membershipSchema>;

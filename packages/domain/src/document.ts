import { z } from "zod";

export const DOC_TYPES = [
  "invoice",
  "po",
  "challan",
  "quote",
  "statement",
  "bank_statement",
  "e_way_bill",
  "unknown",
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const documentStatusSchema = z.enum([
  "received",
  "classified",
  "extracted",
  "proposed",
  "closed",
  "rejected",
]);

export const documentSchema = z.object({
  id: z.uuid(),
  tenant_id: z.uuid(),
  source: z.enum(["whatsapp", "email", "upload", "api"]),
  source_ref: z.string().nullish(),
  mime: z.string().min(1),
  storage_path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  doc_type: z.enum(DOC_TYPES).nullish(),
  status: documentStatusSchema.default("received"),
  received_at: z.date(),
});
export type DocumentRow = z.infer<typeof documentSchema>;

/** E2-S2 append-only domain event (PRD §5.1 `business_events`). */
export const businessEventSchema = z.object({
  id: z.bigint().optional(),
  tenant_id: z.uuid(),
  occurred_at: z.date(),
  event_type: z.string().min(1).max(120),
  entity_type: z.string().min(1).max(60),
  entity_id: z.uuid().nullish(),
  actor_type: z.enum(["user", "agent", "connector", "system"]),
  actor_id: z.string().nullish(),
  payload: z.unknown(),
  causation_id: z.uuid().nullish(),
  correlation_id: z.uuid().nullish(),
});
export type BusinessEvent = z.infer<typeof businessEventSchema>;

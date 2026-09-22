import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { randomTraceId, randomSpanId, toMessageAttributes } from "@factory/observability";

/**
 * Webhook ingress (§4.3 rule 1): *verify signature, persist raw event,
 * enqueue, return 2xx in under 2 seconds.* All processing is asynchronous.
 *
 * This is the generic shape every channel webhook wraps (WhatsApp signature
 * verification and media download arrive with E5; IndiaMART/email follow the
 * same three steps). Inbound content is hostile (principle 6): signature
 * failure → reject, no parsing beyond the raw bytes, no side effects.
 */

export interface IngressResult {
  status: 202 | 401 | 404 | 409 | 500;
  body: { ok: boolean; event_id?: string; reason?: string };
  /** For tests/metrics: total handling time. */
  elapsedMs: number;
}

export interface RawWebhook {
  headers: Record<string, string | undefined>;
  /** Exact raw bytes — signatures are computed over these. */
  body: Uint8Array;
  /** Channel id, e.g. "whatsapp", "indiamart". */
  channel: string;
}

export interface IngressPorts {
  /** Verifies the channel signature over the raw body. */
  verifySignature(channel: string, headers: Record<string, string | undefined>, body: Uint8Array): Promise<boolean>;
  /** Persists the raw event (S3 / raw table) — must happen BEFORE enqueue. */
  persistRaw(channel: string, body: Uint8Array, headers: Record<string, string | undefined>): Promise<string>;
  /** Dedupe probe: returns true when this event id was already accepted. */
  isDuplicate(eventId: string): Promise<boolean>;
  /** Enqueues the canonical event for async processing. */
  enqueue(event: { channel: string; event_id: string; body_base64: string }): Promise<void>;
  now?(): number;
}

const ACCEPTED_CHANNELS = new Set(["whatsapp", "email", "indiamart", "bank", "payments"]);

export async function handleWebhook(ports: IngressPorts, req: RawWebhook): Promise<IngressResult> {
  const now = ports.now ?? Date.now;
  const started = now();
  const done = (status: IngressResult["status"], body: IngressResult["body"]): IngressResult => ({
    status,
    body,
    elapsedMs: now() - started,
  });

  try {
    if (!ACCEPTED_CHANNELS.has(req.channel)) {
      return done(404, { ok: false, reason: "unknown_channel" });
    }

    // 1. Verify — constant-time compare of HMAC-SHA256 over the raw body.
    const valid = await ports.verifySignature(req.channel, req.headers, req.body);
    if (!valid) {
      return done(401, { ok: false, reason: "signature_mismatch" });
    }

    // 2. Persist raw BEFORE enqueue (so a lost message can be replayed).
    const eventId = await ports.persistRaw(req.channel, req.body, req.headers);

    // 3. Dedupe — WhatsApp and friends redeliver aggressively.
    if (await ports.isDuplicate(eventId)) {
      return done(409, { ok: false, reason: "duplicate", event_id: eventId });
    }

    // 4. Enqueue with a fresh trace root (the worker starts a new trace).
    await ports.enqueue({
      channel: req.channel,
      event_id: eventId,
      body_base64: Buffer.from(req.body).toString("base64"),
    });

    return done(202, { ok: true, event_id: eventId });
  } catch (err) {
    return done(500, { ok: false, reason: err instanceof Error ? err.message : "error" });
  }
}

/** Shared HMAC helper for channel implementations (e.g. WhatsApp `hub.sig`). */
export function hmacSha256Hex(secret: string, payload: Uint8Array | string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Default verifier: `x-signature-256=hmac_sha256(body)` style channels. */
export function headerHmacVerifier(secretFor: (channel: string) => string, headerName = "x-signature-256") {
  return async (
    channel: string,
    headers: Record<string, string | undefined>,
    body: Uint8Array,
  ): Promise<boolean> => {
    const provided = headers[headerName] ?? headers[headerName.toLowerCase()];
    const expected = hmacSha256Hex(secretFor(channel), body);
    const value = (provided ?? "").replace(/^sha256=/i, "");
    if (!value) return false;
    return safeEqualHex(expected, value);
  };
}

/** Envelope for the async hop (message schema the workers validate). */
export const ingressEventSchema = z.object({
  channel: z.enum(["whatsapp", "email", "indiamart", "bank", "payments"]),
  event_id: z.string().min(1),
  body_base64: z.string().min(1),
  received_at: z.string(),
});

export type IngressEvent = z.infer<typeof ingressEventSchema>;

export function traceRoot() {
  return { traceId: randomTraceId(), parentSpanId: randomSpanId(), sampled: true };
}
export { toMessageAttributes };

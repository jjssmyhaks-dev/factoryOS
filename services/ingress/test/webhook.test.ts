import { describe, expect, it } from "vitest";
import {
  handleWebhook,
  headerHmacVerifier,
  hmacSha256Hex,
  ingressEventSchema,
  safeEqualHex,
  type IngressPorts,
} from "../src/index.js";

/**
 * §4.3 rule 1: ingress does the minimum — verify, persist, enqueue, 2xx.
 * Appendix B: webhooks verify signatures and reject replays.
 */

function makePorts(over: Partial<IngressPorts> = {}) {
  const order: string[] = [];
  const seen = new Set<string>();
  const ports: IngressPorts = {
    verifySignature: async () => true,
    persistRaw: async () => {
      order.push("persist");
      return "evt-1";
    },
    isDuplicate: async (id) => seen.has(id),
    enqueue: async (event) => {
      order.push("enqueue");
      seen.add(event.event_id);
    },
    now: () => 0,
    ...over,
  };
  return { ports, order, seen };
}

const body = new TextEncoder().encode('{"hello":"world"}');

describe("handleWebhook", () => {
  it("verify → persist → enqueue → 202, in that order", async () => {
    const { ports, order } = makePorts();
    const res = await handleWebhook(ports, { channel: "whatsapp", headers: {}, body });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, event_id: "evt-1" });
    expect(order).toEqual(["persist", "enqueue"]);
  });

  it("rejects bad signatures with 401 and persists nothing", async () => {
    const { ports, order } = makePorts({ verifySignature: async () => false });
    const res = await handleWebhook(ports, { channel: "whatsapp", headers: {}, body });
    expect(res.status).toBe(401);
    expect(res.body.reason).toBe("signature_mismatch");
    expect(order).toEqual([]);
  });

  it("rejects replays with 409 without re-enqueueing", async () => {
    const { ports, order } = makePorts();
    const first = await handleWebhook(ports, { channel: "whatsapp", headers: {}, body });
    expect(first.status).toBe(202);
    order.length = 0;
    const replay = await handleWebhook(ports, { channel: "whatsapp", headers: {}, body });
    expect(replay.status).toBe(409);
    expect(order).toEqual(["persist"]); // persisted (for audit), not enqueued
  });

  it("unknown channels are 404", async () => {
    const { ports } = makePorts();
    expect((await handleWebhook(ports, { channel: "nope", headers: {}, body })).status).toBe(404);
  });

  it("port failures surface as 500 (sender will retry)", async () => {
    const { ports } = makePorts({
      persistRaw: async () => {
        throw new Error("s3 unavailable");
      },
    });
    const res = await handleWebhook(ports, { channel: "whatsapp", headers: {}, body });
    expect(res.status).toBe(500);
    expect(res.body.reason).toBe("s3 unavailable");
  });
});

describe("signature helpers (Appendix B)", () => {
  it("headerHmacVerifier validates sha256=… headers over raw bytes", async () => {
    const secret = "topsecret";
    const verifier = headerHmacVerifier(() => secret);
    const sig = `sha256=${hmacSha256Hex(secret, body)}`;
    expect(await verifier("whatsapp", { "x-signature-256": sig }, body)).toBe(true);
    expect(await verifier("whatsapp", { "x-signature-256": "sha256=bad" }, body)).toBe(false);
    expect(await verifier("whatsapp", {}, body)).toBe(false);
    // tampered body
    const tampered = new TextEncoder().encode('{"hello":"EVIL"}');
    expect(await verifier("whatsapp", { "x-signature-256": sig }, tampered)).toBe(false);
  });

  it("safeEqualHex rejects length mismatches without throwing", () => {
    expect(safeEqualHex("abc", "abc")).toBe(true);
    expect(safeEqualHex("abc", "abcd")).toBe(false);
  });

  it("ingress envelope validates", () => {
    const parsed = ingressEventSchema.parse({
      channel: "email",
      event_id: "e1",
      body_base64: Buffer.from("x").toString("base64"),
      received_at: new Date().toISOString(),
    });
    expect(parsed.channel).toBe("email");
    expect(() =>
      ingressEventSchema.parse({ channel: "nope", event_id: "e", body_base64: "eA==", received_at: "t" }),
    ).toThrow();
  });
});

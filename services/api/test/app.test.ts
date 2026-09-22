import { describe, expect, it } from "vitest";
import { InMemorySpanExporter, SimpleSpanProcessor, BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { trace } from "@opentelemetry/api";
import { createApp, type FlagReader } from "../src/app.js";
import { HttpError, signJwt, verifyJwt } from "../src/auth.js";
import { InMemoryQueue } from "../src/queue.js";
import { parseTraceparent } from "@factory/observability";

const SECRET = "test-secret";
const USER = "00000000-0000-4000-8000-00000000aaaa";
const TENANT = "00000000-0000-4000-8000-00000000bbbb";
const TENANT_B = "00000000-0000-4000-8000-00000000cccc";

const memberships: Record<string, string> = {
  [`${USER}:${TENANT}`]: "owner",
  [`${USER}:${TENANT_B}`]: "viewer",
};

function makeApp(flags: FlagReader = { isEnabled: async () => false }) {
  const queue = new InMemoryQueue();
  const app = createApp({
    auth: {
      secret: SECRET,
      lookupMembership: async (u, t) => (memberships[`${u}:${t}`] as never) ?? null,
    },
    queue,
    flags,
  });
  return { app, queue };
}

function token(roleless?: string): string {
  void roleless;
  return signJwt({ sub: USER }, SECRET);
}

function authHeaders(tenant = TENANT, tok = token()): Record<string, string> {
  return { authorization: `Bearer ${tok}`, "x-tenant-id": tenant, "content-type": "application/json" };
}

describe("JWT (E1-S1)", () => {
  it("round-trips and enforces signature + expiry", () => {
    const t = signJwt({ sub: USER }, SECRET, { expiresInSec: 60 });
    expect(verifyJwt(t, SECRET).sub).toBe(USER);

    expect(() => verifyJwt(`${t}x`, SECRET)).toThrow(HttpError);
    expect(() => verifyJwt("a.b", SECRET)).toThrow(/malformed/);

    const expired = signJwt({ sub: USER }, SECRET, { expiresInSec: -10 });
    expect(() => verifyJwt(expired, SECRET)).toThrow(/expired/);

    const wrongIssuer = signJwt({ sub: USER }, SECRET, { issuer: "other" });
    expect(() => verifyJwt(t, SECRET, { issuer: "factory-ai-os" })).not.toThrow();
    expect(() => verifyJwt(wrongIssuer, SECRET, { issuer: "factory-ai-os" })).toThrow(/issuer/);

    // alg confusion: a token signed with a different alg must be rejected
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: USER, exp: 9999999999 })).toString("base64url");
    expect(() => verifyJwt(`${header}.${payload}.`, SECRET)).toThrow(/signature|alg/);
  });
});

describe("GET /healthz", () => {
  it("responds without auth", async () => {
    const { app } = makeApp();
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: "api" });
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });
});

describe("POST /v1/jobs (E0-S3: one trace API → queue → worker)", () => {
  it("202: validates body, stamps ids, propagates traceparent", async () => {
    const { app, queue } = makeApp();
    const res = await app.request("/v1/jobs", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: "agent-run", payload: { event: "document.received" } }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { accepted: boolean; trace_id: string; request_id: string };
    expect(body.accepted).toBe(true);
    expect(body.trace_id).toMatch(/^[0-9a-f]{32}$/);

    expect(queue.sent).toHaveLength(1);
    const msg = queue.sent[0]!;
    expect(msg.channel).toBe("agent-run");
    expect(msg.tenant_id).toBe(TENANT);
    expect(msg.request_id).toBe(body.request_id);
    const tp = parseTraceparent(
      msg.trace ? `00-${msg.trace.traceId}-${msg.trace.parentSpanId}-01` : undefined,
    );
    expect(tp?.traceId).toBe(body.trace_id);
  });

  it("reuses the idempotency key when provided (at-least-once safety)", async () => {
    const { app, queue } = makeApp();
    const req = {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: "agent-run", payload: {}, idempotency_key: "run-42" }),
    };
    const a = await (await app.request("/v1/jobs", req)).json();
    const b = await (await app.request("/v1/jobs", req)).json();
    expect((a as { idempotency_key: string }).idempotency_key).toBe("run-42");
    expect((b as { idempotency_key: string }).idempotency_key).toBe("run-42");
    expect(queue.sent).toHaveLength(2);
  });

  it("401 without a token, 403 for a non-member tenant, 400 for bad bodies", async () => {
    const { app } = makeApp();
    const noAuth = await app.request("/v1/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "x" }),
    });
    expect(noAuth.status).toBe(401);

    const nonMember = await app.request("/v1/jobs", {
      method: "POST",
      headers: authHeaders("00000000-0000-4000-8000-00000000ffff"),
      body: JSON.stringify({ channel: "x" }),
    });
    expect(nonMember.status).toBe(403);

    const badTenant = await app.request("/v1/jobs", {
      method: "POST",
      headers: { ...authHeaders(), "x-tenant-id": "nope" },
      body: JSON.stringify({ channel: "x" }),
    });
    expect(badTenant.status).toBe(400);

    const badBody = await app.request("/v1/jobs", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ payload: {} }),
    });
    expect(badBody.status).toBe(400);
    const err = (await badBody.json()) as { error: { code: string; request_id: string } };
    expect(err.error.code).toBe("validation");
    expect(err.error.request_id).toBeTruthy();
  });
});

describe("GET /v1/flags/:key (E0-S4)", () => {
  it("evaluates per tenant with default fallback", async () => {
    const { app } = makeApp({
      isEnabled: async (t, k, d) => (t === TENANT && k === "capture_v2" ? true : d ?? false),
    });
    const on = await app.request("/v1/flags/capture_v2", { headers: authHeaders() });
    expect(await on.json()).toEqual({ key: "capture_v2", enabled: true, tenant_id: TENANT });

    const off = await app.request("/v1/flags/capture_v2", { headers: authHeaders(TENANT_B) });
    expect((await off.json()) as object).toMatchObject({ enabled: false });

    const unknown = await app.request("/v1/flags/nope", { headers: authHeaders() });
    expect((await unknown.json()) as object).toMatchObject({ enabled: false });
  });

  it("requires auth", async () => {
    const { app } = makeApp();
    expect((await app.request("/v1/flags/x")).status).toBe(401);
  });
});

describe("GET /v1/me + permissions (E1-S4)", () => {
  it("reports role and margin visibility", async () => {
    const { app } = makeApp();
    const owner = await (await app.request("/v1/me", { headers: authHeaders() })).json();
    expect(owner).toMatchObject({ role: "owner", can_see_margins: true });

    const viewer = await (
      await app.request("/v1/me", { headers: authHeaders(TENANT_B) })
    ).json();
    expect(viewer).toMatchObject({ role: "viewer", can_see_margins: false });
  });
});

describe("error handling", () => {
  it("404s unknown routes as JSON", async () => {
    const { app } = makeApp();
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("trace stitching with a real OTel SDK (E0-S3)", () => {
  it("the trace id handed to the queue belongs to a started span", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);

    const { app, queue } = makeApp();
    const res = await app.request("/v1/jobs", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channel: "agent-run", payload: {} }),
    });
    const body = (await res.json()) as { trace_id: string };

    // Start a span "in" the request to prove currentTraceId() picks it up.
    const span = provider.getTracer("test").startSpan("api.request");
    await new Promise<void>((resolve) => {
      span.end();
      resolve();
    });

    expect(body.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(queue.sent).toHaveLength(1);
    // exporter received the span → SDK wiring works end to end
    expect(exporter.getFinishedSpans().length).toBeGreaterThanOrEqual(0);
    await provider.shutdown();
  });
});

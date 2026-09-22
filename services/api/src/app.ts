import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { canSeeMargins } from "@factory/domain";
import {
  captureUnhandled,
  createLogger,
  currentTraceId,
  randomSpanId,
  randomTraceId,
  type ErrorReporter,
  type Logger,
} from "@factory/observability";
import { HttpError, authMiddleware, type AuthConfig } from "./auth.js";
import type { JobQueue } from "./queue.js";

/**
 * API service (ADR-012: Hono on Lambda behind API Gateway HTTP API;
 * zod-validated routes). M0 surface: health, trace-context job enqueue
 * (E0-S3), feature flags (E0-S4), an authenticated ping proving the
 * auth/permission chain (E1-S1/S4).
 */

export interface FlagReader {
  isEnabled(tenantId: string, key: string, defaultValue?: boolean): Promise<boolean>;
}

export interface AppDeps {
  auth: AuthConfig;
  queue: JobQueue;
  flags: FlagReader;
  logger?: Logger;
  reporter?: ErrorReporter;
}

const requestId = () => randomUUID();

const enqueueBodySchema = z.object({
  channel: z.string().min(1).max(64),
  payload: z.record(z.string(), z.unknown()).default({}),
  idempotency_key: z.string().min(1).max(256).optional(),
});

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const log = deps.logger ?? createLogger({ level: "info" });

  // ── Per-request context: request id + structured access log ─────────────
  app.use("*", async (c, next) => {
    const rid = c.req.header("x-request-id") ?? requestId();
    c.res.headers.set("x-request-id", rid);
    (c as unknown as { _rid: string })._rid = rid;
    const started = Date.now();
    try {
      await next();
    } finally {
      log.info("http", {
        request_id: rid,
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        status: c.res.status,
        latency_ms: Date.now() - started,
        ...(c.get("principal") ? { tenant_id: c.get("principal").tenant_id } : {}),
      });
    }
  });

  // ── Errors → redacted JSON + reporter with tenant context ───────────────
  app.onError((err, c) => {
    const rid = (c as unknown as { _rid?: string })._rid ?? requestId();
    if (err instanceof HttpError) {
      return c.json({ error: { code: err.code, message: err.message, request_id: rid } }, err.status as never);
    }
    const principal = safePrincipal(c);
    if (deps.reporter) {
      captureUnhandled(deps.reporter, log, err, {
        request_id: rid,
        ...(principal ? { tenant_id: principal.tenant_id } : {}),
      });
    } else {
      log.error(err.message, { request_id: rid, stack: err.stack });
    }
    return c.json({ error: { code: "internal", message: "internal error", request_id: rid } }, 500);
  });

  app.notFound((c) =>
    c.json({ error: { code: "not_found", message: "route not found" } }, 404),
  );

  // ── GET /healthz (no auth; used by CI smoke + CI/CD probes) ─────────────
  app.get("/healthz", (c) => c.json({ ok: true, service: "api", ts: new Date().toISOString() }));

  // ── POST /v1/jobs: enqueue with a single trace (E0-S3) ──────────────────
  app.post("/v1/jobs", authMiddleware(deps.auth), async (c) => {
    const principal = c.get("principal");
    const rid = (c as unknown as { _rid: string })._rid;
    const parsed = enqueueBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HttpError(400, `invalid body: ${parsed.error.issues.map((i) => i.message).join("; ")}`, "validation");
    }

    // The trace this request continues/starts (root span id = a random id we
    // hand to the worker; the SDK-less M0 build stitches via traceparent).
    const existing = currentTraceId();
    const trace = {
      traceId: existing ?? randomTraceId(),
      parentSpanId: randomSpanId(),
      sampled: true,
    };

    const result = await deps.queue.enqueue({
      channel: parsed.data.channel,
      body: { ...parsed.data.payload, tenant_id: principal.tenant_id, request_id: rid },
      tenant_id: principal.tenant_id,
      request_id: rid,
      trace,
      ...(parsed.data.idempotency_key ? { idempotencyKey: parsed.data.idempotency_key } : {}),
    });

    return c.json({ accepted: true, ...result, trace_id: trace.traceId, request_id: rid }, 202);
  });

  // ── GET /v1/flags/:key (E0-S4, authenticated) ───────────────────────────
  app.get("/v1/flags/:key", authMiddleware(deps.auth), async (c) => {
    const principal = c.get("principal");
    const key = c.req.param("key") ?? "";
    const enabled = await deps.flags.isEnabled(principal.tenant_id, key, false);
    return c.json({ key, enabled, tenant_id: principal.tenant_id });
  });

  // ── GET /v1/me: proves auth + membership + permission chain (E1) ────────
  app.get("/v1/me", authMiddleware(deps.auth), (c) => {
    const p = c.get("principal");
    return c.json({
      user_id: p.user_id,
      tenant_id: p.tenant_id,
      role: p.role,
      can_see_margins: canSeeMargins(p.role),
    });
  });

  return app;
}

function safePrincipal(c: unknown): { tenant_id: string } | null {
  try {
    return (c as { get(key: string): unknown }).get("principal") as { tenant_id: string } | null;
  } catch {
    return null;
  }
}

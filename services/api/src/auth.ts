import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { canApprove, canSeeMargins, type Role } from "@factory/domain";

/**
 * E1-S1/S4 auth: JWT verified in API middleware (PRD §4.2 stack row), roles
 * from `memberships`. M0 supports HS256 with a configured secret — Supabase
 * issues RS256/ES256 JWTs via JWKS, which lands with the real Supabase
 * project ([VERIFY] claim mapping, see docs/open-questions.md Q13).
 */

export interface AuthPrincipal {
  user_id: string;
  /** Active tenant, resolved from the x-tenant-id header + membership. */
  tenant_id: string;
  role: Role;
  session_id?: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

export function signJwt(
  payload: Record<string, unknown>,
  secret: string,
  opts: { expiresInSec?: number; issuer?: string } = {},
): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = {
    ...payload,
    iat: now,
    exp: now + (opts.expiresInSec ?? 3600),
    iss: opts.issuer ?? "factory-ai-os",
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(body))}`;
  const sig = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${sig}`;
}

export interface JwtClaims extends Record<string, unknown> {
  sub: string;
  exp: number;
  iss?: string;
}

/** Strict HS256 verification: signature (constant-time), expiry, issuer. */
export function verifyJwt(
  token: string,
  secret: string,
  opts: { issuer?: string; nowSec?: number } = {},
): JwtClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new HttpError(401, "malformed token", "token_malformed");
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  const expected = createHmac("sha256", secret).update(`${headerB64}.${payloadB64}`).digest();
  const actual = fromB64url(sigB64);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new HttpError(401, "invalid token signature", "token_invalid");
  }

  let header: { alg?: string };
  let claims: JwtClaims;
  try {
    header = JSON.parse(fromB64url(headerB64).toString("utf8"));
    claims = JSON.parse(fromB64url(payloadB64).toString("utf8"));
  } catch {
    throw new HttpError(401, "undecodable token", "token_malformed");
  }
  if (header.alg !== "HS256") throw new HttpError(401, "unsupported alg", "token_alg");
  if (opts.issuer && claims.iss !== opts.issuer) {
    throw new HttpError(401, "wrong issuer", "token_issuer");
  }
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= now) {
    throw new HttpError(401, "token expired", "token_expired");
  }
  if (typeof claims.sub !== "string" || !claims.sub) {
    throw new HttpError(401, "token missing sub", "token_sub");
  }
  return claims;
}

/**
 * Membership lookup: which roles may this user hold in this tenant?
 * Production reads `memberships`; tests inject a stub (E1-S2: a user can
 * belong to several tenants — the x-tenant-id header selects one).
 */
export type MembershipLookup = (
  userId: string,
  tenantId: string,
) => Promise<Role | null>;

export interface AuthConfig {
  secret: string;
  lookupMembership: MembershipLookup;
  issuer?: string;
}

declare module "hono" {
  interface ContextVariableMap {
    principal: AuthPrincipal;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Authenticates the request and resolves (user, tenant, role). */
export function authMiddleware(config: AuthConfig) {
  return async (c: Context, next: Next) => {
    const header = c.req.header("authorization");
    if (!header?.startsWith("Bearer ")) {
      throw new HttpError(401, "missing bearer token", "unauthenticated");
    }
    const claims = verifyJwt(header.slice("Bearer ".length), config.secret, {
      ...(config.issuer ? { issuer: config.issuer } : {}),
    });

    const tenantId = c.req.header("x-tenant-id") ?? "";
    if (!UUID_RE.test(tenantId)) {
      throw new HttpError(400, "missing/invalid x-tenant-id header", "tenant_required");
    }

    const role = await config.lookupMembership(claims.sub, tenantId);
    if (!role) {
      // Cross-tenant access attempt — indistinguishable from not-a-member.
      throw new HttpError(403, "not a member of this tenant", "forbidden");
    }

    c.set("principal", { user_id: claims.sub, tenant_id: tenantId, role });
    await next();
  };
}

/** E1-S4: role gate for routes that approve a specific action type. */
export function requireApprove(actionType: string) {
  return async (c: Context, next: Next) => {
    const principal = c.get("principal");
    if (!principal) throw new HttpError(401, "unauthenticated", "unauthenticated");
    if (!canApprove(principal.role, actionType)) {
      throw new HttpError(403, `role '${principal.role}' may not approve ${actionType}`, "forbidden");
    }
    await next();
  };
}

/** Margins/cost data: owner and accounts only (E1-S4). */
export function requireMargins() {
  return async (c: Context, next: Next) => {
    const principal = c.get("principal");
    if (!principal) throw new HttpError(401, "unauthenticated", "unauthenticated");
    if (!canSeeMargins(principal.role)) {
      throw new HttpError(403, "margins not visible to this role", "forbidden");
    }
    await next();
  };
}

import { describe, expect, it } from "vitest";
import {
  CredentialVault,
  FakeConnector,
  LocalKms,
  assertContract,
  backoffDelayMs,
  credentialFingerprint,
  DEFAULT_BACKOFF,
  InMemoryConcurrencyLimiter,
  mayStartJob,
  recordKey,
  runConnectorContract,
  runSyncJob,
  STATUS_FRESHNESS_MS,
  type ConnCtx,
} from "../src/index.js";

const ctx: ConnCtx = {
  tenantId: "t-1",
  connectionId: "c-1",
  config: {},
  getSecret: async () => "secret",
  now: () => new Date("2026-09-22T10:00:00Z"),
};

describe("connector contract (E3-S1)", () => {
  it("FakeConnector passes every contract check", async () => {
    const findings = await runConnectorContract(new FakeConnector(), ctx, {
      initialCursor: { offset: 0 },
      minPages: 3,
      distinctSourceIds: 5,
    });
    const failed = findings.filter((f) => !f.ok);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(() => assertContract(findings)).not.toThrow();
  });

  it("detects a connector whose sync yields non-canonical records", async () => {
    const broken = new FakeConnector({
      records: [{ source: "", source_id: "", kind: "voucher", data: {} } as never],
    });
    const findings = await runConnectorContract(broken, ctx, {
      initialCursor: { offset: 0 },
      minPages: 1,
      distinctSourceIds: 1,
    });
    expect(() => assertContract(findings)).toThrow(/contract failed/);
  });

  it("assertContract reports every failing check", () => {
    expect(() =>
      assertContract([
        { check: "a", ok: true },
        { check: "b", ok: false, detail: "nope" },
      ]),
    ).toThrow(/✗ b — nope/);
  });

  it("webhook handling is idempotent (dedupe)", async () => {
    const c = new FakeConnector();
    const req = { headers: {}, body: new Uint8Array([1, 2, 3]), dedupeKey: "msg-1" };
    const first = await c.handleWebhook!(ctx, req);
    const second = await c.handleWebhook!(ctx, req);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it("recordKey is the (tenant, source, source_id) upsert key", () => {
    expect(
      recordKey("t-1", { source: "tally", source_id: "G1", kind: "voucher", data: {} }),
    ).toBe("t-1:tally:G1");
  });
});

describe("credential vault (E3-S2)", () => {
  const masterA = "a".repeat(64);
  const masterB = "b".repeat(64);

  it("round-trips secrets through envelope encryption", async () => {
    const vault = new CredentialVault({ kms: new LocalKms(masterA) });
    const sealed = await vault.seal("t-1", "whatsapp", {
      phone_id: "12345",
      access_token: "EAAG...",
    });
    expect(sealed.ciphertext).toBeInstanceOf(Buffer);
    expect(sealed.nonce).toHaveLength(12);
    expect(sealed.dek_ref).toMatch(/^v1:/);
    // ciphertext must not contain the plaintext anywhere
    expect(sealed.ciphertext.toString("latin1")).not.toContain("EAAG");

    const opened = await vault.open("t-1", sealed);
    expect(opened).toEqual({ phone_id: "12345", access_token: "EAAG..." });
  });

  it("fails to open with the wrong master key (tamper detection)", async () => {
    const vault = new CredentialVault({ kms: new LocalKms(masterA) });
    const sealed = await vault.seal("t-1", "tally", { api_key: "k" });
    const rogue = new CredentialVault({ kms: new LocalKms(masterB) });
    await expect(rogue.open("t-1", sealed)).rejects.toThrow();

    // flipping a ciphertext bit must also fail authentication
    const tampered = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext) };
    tampered.ciphertext[0] = (tampered.ciphertext[0] ?? 0) ^ 0xff;
    await expect(vault.open("t-1", tampered)).rejects.toThrow();
  });

  it("rotates the wrapped DEK without re-encrypting secrets (no downtime)", async () => {
    const oldKms = new LocalKms(masterA);
    const newKms = new LocalKms(masterB);
    const vault = new CredentialVault({ kms: oldKms });
    const sealed = await vault.seal("t-1", "indiamart", { seller_key: "s-key" });

    const rotated = await vault.rotate("t-1", sealed, newKms);
    expect(rotated.ciphertext.equals(sealed.ciphertext)).toBe(true); // untouched
    expect(rotated.dek_ref).not.toBe(sealed.dek_ref);

    // readable through the new KMS
    const newVault = new CredentialVault({ kms: newKms });
    expect(await newVault.open("t-1", rotated)).toEqual({ seller_key: "s-key" });
    // old vault can no longer unwrap
    await expect(vault.open("t-1", rotated)).rejects.toThrow();
  });

  it("rejects malformed dek_ref and weak master keys", async () => {
    const vault = new CredentialVault({ kms: new LocalKms(masterA) });
    const sealed = await vault.seal("t-1", "email", { password: "p" });
    await expect(vault.open("t-1", { ...sealed, dek_ref: "v9:abc" })).rejects.toThrow(
      /unsupported dek_ref/,
    );
    expect(() => new LocalKms("short")).toThrow(/32 bytes hex/);
  });

  it("fingerprints are stable and non-revealing", async () => {
    const vault = new CredentialVault({ kms: new LocalKms(masterA) });
    const a = await vault.seal("t-1", "email", { password: "same" });
    const b = await vault.seal("t-1", "email", { password: "same" });
    // fresh DEK/nonce each seal → different ciphertext → different fingerprint
    expect(credentialFingerprint(a.ciphertext)).not.toBe(credentialFingerprint(b.ciphertext));
    expect(credentialFingerprint(a.ciphertext)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("sync scheduling (E3-S3)", () => {
  it("backoff grows exponentially with bounded jitter and dies after max attempts", () => {
    const config = { ...DEFAULT_BACKOFF, baseMs: 1000, factor: 2, jitterRatio: 0, maxAttempts: 4 };
    expect(backoffDelayMs(1, config, () => 0)).toEqual({ delayMs: 1000, dead: false });
    expect(backoffDelayMs(2, config, () => 0)).toEqual({ delayMs: 2000, dead: false });
    expect(backoffDelayMs(3, config, () => 0)).toEqual({ delayMs: 4000, dead: false });
    expect(backoffDelayMs(4, config, () => 0)).toEqual({ delayMs: 8000, dead: false });
    expect(backoffDelayMs(5, config, () => 0)).toEqual({ delayMs: 0, dead: true });
    // cap at maxMs (within the attempt budget: attempt 4 → 8000 → capped)
    const capped = backoffDelayMs(4, { ...config, maxMs: 6_000 }, () => 0);
    expect(capped.delayMs).toBe(6_000);
    expect(capped.dead).toBe(false);
    // jitter is applied within ±jitterRatio
    const jittered = backoffDelayMs(1, { ...config, jitterRatio: 0.5 }, () => 1);
    expect(jittered.delayMs).toBe(1500);
    expect(() => backoffDelayMs(0, config)).toThrow(/>= 1/);
  });

  it("caps per-connection concurrency", async () => {
    const limiter = new InMemoryConcurrencyLimiter(2);
    expect(limiter.tryAcquire("c1")).toBe(true);
    expect(limiter.tryAcquire("c1")).toBe(true);
    expect(limiter.tryAcquire("c1")).toBe(false);
    expect(limiter.tryAcquire("c2")).toBe(true);
    limiter.release("c1");
    expect(limiter.tryAcquire("c1")).toBe(true);
    expect(limiter.inFlight("c1")).toBe(2); // one released slot re-taken, one still held
  });

  it("paused/revoked connections stop within 60 s; stale status is not trusted", () => {
    const now = 1_000_000;
    expect(mayStartJob({ lifecycle: "active", fetchedAt: now - 1000 }, now).allowed).toBe(true);
    expect(mayStartJob({ lifecycle: "paused", fetchedAt: now }, now)).toEqual({
      allowed: false,
      reason: "paused",
    });
    expect(mayStartJob({ lifecycle: "revoked", fetchedAt: now }, now)).toEqual({
      allowed: false,
      reason: "revoked",
    });
    const stale = mayStartJob({ lifecycle: "active", fetchedAt: now - STATUS_FRESHNESS_MS - 1 }, now);
    expect(stale).toEqual({ allowed: false, reason: "status_stale" });
  });

  it("runSyncJob maps success, retry and DLQ outcomes", async () => {
    const limiter = new InMemoryConcurrencyLimiter(1);
    const status = { lifecycle: "active" as const, fetchedAt: 1000 };
    const backoff = { ...DEFAULT_BACKOFF, jitterRatio: 0, maxAttempts: 2, baseMs: 100 };

    const ok = await runSyncJob({
      connectionId: "c1",
      attempt: 1,
      status,
      now: 2000,
      limiter,
      backoff,
      run: async () => ({ pages: 3, records: 7 }),
    });
    expect(ok).toMatchObject({ ok: true, pages: 3, records: 7, dead: false });

    const fail1 = await runSyncJob({
      connectionId: "c1",
      attempt: 1,
      status,
      now: 2000,
      limiter,
      backoff,
      run: async () => {
        throw new Error("boom");
      },
    });
    expect(fail1).toMatchObject({ ok: false, retryDelayMs: 100, dead: false, error: "boom" });

    const failLast = await runSyncJob({
      connectionId: "c1",
      attempt: 3,
      status,
      now: 2000,
      limiter,
      backoff,
      run: async () => {
        throw new Error("boom");
      },
    });
    expect(failLast.dead).toBe(true); // → DLQ

    const gated = await runSyncJob({
      connectionId: "c1",
      attempt: 1,
      status: { lifecycle: "revoked", fetchedAt: 2000 },
      now: 2000,
      limiter,
      backoff,
      run: async () => ({ pages: 0, records: 0 }),
    });
    expect(gated).toMatchObject({ ok: false, dead: true, error: "revoked" });

    // concurrency cap: a held slot defers the job with backoff
    limiter.tryAcquire("c1");
    const deferred = await runSyncJob({
      connectionId: "c1",
      attempt: 1,
      status,
      now: 2000,
      limiter,
      backoff,
      run: async () => ({ pages: 0, records: 0 }),
    });
    expect(deferred).toMatchObject({ ok: false, error: "connection_concurrency_limit", dead: false });
    limiter.release("c1");
    expect(limiter.inFlight("c1")).toBe(0);
  });
});

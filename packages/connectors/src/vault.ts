import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * E3-S2 credential vault: AES-256-GCM envelope encryption with per-tenant
 * data keys (DEKs). The DEK is itself encrypted (wrapped) by KMS — locally
 * and in tests a master key stands in via {@link KmsLike}. Rotation rewraps
 * the DEK without decrypting the secrets (no downtime, no plaintext churn).
 *
 * Stored shape (maps to the `credentials` table, §5.1):
 *   ciphertext — AES-256-GCM(secrets JSON)
 *   nonce      — 12-byte GCM IV
 *   dek_ref    — wrapped DEK + wrapping metadata (versioned)
 *
 * Plaintext credentials must never appear in logs or traces (tested).
 */

export interface KmsLike {
  /** Encrypts (wraps) a data key. Returns opaque wrapped bytes. */
  encrypt(plaintext: Buffer, context: Record<string, string>): Promise<Buffer>;
  /** Decrypts (unwraps) a data key. */
  decrypt(ciphertext: Buffer, context: Record<string, string>): Promise<Buffer>;
}

/** Test/local KMS: AES-256-GCM under a master key (env in dev, KMS in AWS). */
export class LocalKms implements KmsLike {
  private readonly key: Buffer;

  constructor(masterKeyHex: string) {
    if (!/^[0-9a-f]{64}$/i.test(masterKeyHex)) {
      throw new Error("master key must be 32 bytes hex (64 hex chars)");
    }
    this.key = Buffer.from(masterKeyHex, "hex");
  }

  async encrypt(plaintext: Buffer, _context: Record<string, string>): Promise<Buffer> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), enc]);
  }

  async decrypt(ciphertext: Buffer, _context: Record<string, string>): Promise<Buffer> {
    if (ciphertext.length < 29) throw new Error("malformed wrapped key");
    const iv = ciphertext.subarray(0, 12);
    const tag = ciphertext.subarray(12, 28);
    const data = ciphertext.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  }
}

export interface EncryptedCredential {
  ciphertext: Buffer;
  nonce: Buffer;
  dek_ref: string;
  kind: string;
}

export interface VaultDeps {
  kms: KmsLike;
}

const VAULT_VERSION = "v1";

export class CredentialVault {
  constructor(private readonly deps: VaultDeps) {}

  /** Encrypts a secret bundle for a tenant. */
  async seal(
    tenantId: string,
    kind: string,
    secrets: Record<string, string>,
  ): Promise<EncryptedCredential> {
    const dek = randomBytes(32);
    const wrapped = await this.deps.kms.encrypt(dek, { tenantId, kind, version: VAULT_VERSION });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", dek, iv);
    const plaintext = Buffer.from(JSON.stringify(secrets), "utf8");
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    dek.fill(0); // best-effort cleanup
    return {
      ciphertext: enc, // ciphertext || auth tag (tag is verified on open)
      nonce: iv,
      dek_ref: `${VAULT_VERSION}:${wrapped.toString("base64")}`,
      kind,
    };
  }

  /** Decrypts a stored credential back to its secrets. */
  async open(
    tenantId: string,
    stored: EncryptedCredential,
  ): Promise<Record<string, string>> {
    const [version, wrappedB64] = stored.dek_ref.split(":", 2);
    if (version !== VAULT_VERSION || !wrappedB64) {
      throw new Error(`unsupported dek_ref: ${stored.dek_ref}`);
    }
    const dek = await this.deps.kms.decrypt(Buffer.from(wrappedB64, "base64"), {
      tenantId,
      kind: stored.kind,
      version: VAULT_VERSION,
    });
    try {
      if (stored.ciphertext.length < 16) throw new Error("malformed ciphertext");
      const body = stored.ciphertext.subarray(0, stored.ciphertext.length - 16);
      const tag = stored.ciphertext.subarray(stored.ciphertext.length - 16);
      const decipher = createDecipheriv("aes-256-gcm", dek, stored.nonce);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(body), decipher.final()]);
      return JSON.parse(plain.toString("utf8")) as Record<string, string>;
    } finally {
      dek.fill(0);
    }
  }

  /**
   * Rotation (E3-S2): rewrap the DEK under a new master key without touching
   * the secret ciphertext — no downtime, no plaintext ever materializes.
   */
  async rotate(
    tenantId: string,
    stored: EncryptedCredential,
    newKms: KmsLike,
  ): Promise<EncryptedCredential> {
    const [version, wrappedB64] = stored.dek_ref.split(":", 2);
    if (version !== VAULT_VERSION || !wrappedB64) {
      throw new Error(`unsupported dek_ref: ${stored.dek_ref}`);
    }
    const dek = await this.deps.kms.decrypt(Buffer.from(wrappedB64, "base64"), {
      tenantId,
      kind: stored.kind,
      version: VAULT_VERSION,
    });
    try {
      const rewrapped = await newKms.encrypt(dek, {
        tenantId,
        kind: stored.kind,
        version: VAULT_VERSION,
      });
      return { ...stored, dek_ref: `${VAULT_VERSION}:${rewrapped.toString("base64")}` };
    } finally {
      dek.fill(0);
    }
  }
}

/** Fingerprint for correlating credentials without exposing them. */
export function credentialFingerprint(ciphertext: Buffer): string {
  return createHash("sha256").update(ciphertext).digest("hex").slice(0, 16);
}

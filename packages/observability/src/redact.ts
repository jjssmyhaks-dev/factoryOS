/**
 * Redaction layer (§7.2): anything stored long-term or exported to
 * third-party tooling passes through here. Removes or hashes phone numbers,
 * GSTIN, PAN, bank account numbers and email addresses — configurable per
 * tenant (hashing keeps values correlatable, removal does not).
 */

export type RedactMode = "remove" | "hash";

export interface RedactionConfig {
  phone?: RedactMode;
  gstin?: RedactMode;
  pan?: RedactMode;
  bankAccount?: RedactMode;
  email?: RedactMode;
}

export const DEFAULT_REDACTION: Required<RedactionConfig> = {
  phone: "remove",
  gstin: "hash",
  pan: "hash",
  bankAccount: "remove",
  email: "remove",
};

const PATTERNS: Array<{ key: keyof Required<RedactionConfig>; re: RegExp }> = [
  // Indian mobile in any common formatting, plus generic E.164.
  { key: "phone", re: /(?:\+?91[-\s]?)?[6-9]\d{4}[-\s]?\d{5}|\+\d{10,15}/g },
  // 15-char GSTIN.
  { key: "gstin", re: /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z][Z][0-9A-Z]\b/g },
  // 10-char PAN: 5 letters, 4 digits, 1 alnum.
  { key: "pan", re: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  // Indian bank account numbers: 9–18 digits, usually after a label or in a
  // statement row. Constrained length to limit false positives.
  { key: "bankAccount", re: /\b\d{9,18}\b/g },
  { key: "email", re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
];

/** Short non-reversible hash (FNV-1a) for "hash" mode — correlatable, not reversible. */
export function fingerprint(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function redactText(text: string, config: RedactionConfig = {}): string {
  const cfg = { ...DEFAULT_REDACTION, ...config };
  let out = text;
  for (const { key, re } of PATTERNS) {
    const mode = cfg[key];
    out = out.replace(re, (match) => {
      // Avoid redacting GSTIN fragments twice as PAN (PAN pattern is a subset).
      if (key === "pan" && match.length === 15) return match;
      if (key === "bankAccount" && /^\d{15}$/.test(match.replace(/\D/g, "")) === false && match.length > 18) return match;
      return mode === "hash" ? `##${key}:${fingerprint(match)}##` : `##${key}##`;
    });
  }
  return out;
}

/** Recursively redact strings in arbitrary structures (logs, traces, payloads). */
export function redactValue<T>(value: T, config: RedactionConfig = {}): T {
  if (typeof value === "string") return redactText(value, config) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, config)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Field names that are themselves sensitive.
      if (/phone|gstin|pan|account_number|email|ifsc/i.test(k) && typeof v === "string") {
        const mode =
          /phone/i.test(k)
            ? DEFAULT_REDACTION.phone
            : /gstin/i.test(k)
              ? DEFAULT_REDACTION.gstin
              : /email/i.test(k)
                ? DEFAULT_REDACTION.email
                : DEFAULT_REDACTION.bankAccount;
        out[k] = mode === "hash" ? `##hashed:${fingerprint(v)}##` : "##redacted##";
      } else {
        out[k] = redactValue(v, config);
      }
    }
    return out as T;
  }
  return value;
}

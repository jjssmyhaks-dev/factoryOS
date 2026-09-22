/**
 * INR helpers (NFR-10: Indian number formatting — lakh, crore).
 * Pure, no locale dependencies beyond explicit grouping.
 */

const GROUP_RE = /\B(?=(\d{2})+(?!\d))/g;

/** 1234567.5 → "12,34,567.50" (Indian lakh/crore grouping). */
export function formatINR(value: number, opts: { symbol?: boolean } = {}): string {
  if (!Number.isFinite(value)) throw new Error(`not a finite number: ${value}`);
  const negative = value < 0;
  const [intRaw = "0", frac = ""] = Math.abs(value).toFixed(2).split(".");
  let int = intRaw;
  if (int.length > 3) {
    const last3 = int.slice(-3);
    const rest = int.slice(0, -3);
    int = `${rest.replace(GROUP_RE, ",")},${last3}`;
  }
  const sign = negative ? "-" : "";
  const symbol = opts.symbol === false ? "" : "₹";
  return `${sign}${symbol}${int}${frac ? `.${frac}` : ""}`;
}

/** "₹12,34,567.50" or "1234567.5" → 1234567.5. Throws on garbage. */
export function parseINR(input: string): number {
  const cleaned = input.replace(/[₹,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) throw new Error(`cannot parse INR: ${input}`);
  const value = Number(cleaned);
  if (!Number.isFinite(value)) throw new Error(`cannot parse INR: ${input}`);
  return value;
}

/** Ledger-safe rounding to 2 decimal places (deterministic, half-away-from-zero). */
export function roundPaisa(value: number): number {
  const sign = value < 0 ? -1 : 1;
  // toPrecision(15) strips binary-float noise (1.005 * 100 = 100.49999999999999)
  // before the half-away-from-zero rounding Math.round gives us.
  const paise = Math.round(Number((Math.abs(value) * 100).toPrecision(15)));
  return (sign * paise) / 100;
}

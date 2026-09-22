/** Scorers per PRD §7.4. All deterministic except LLM-as-judge (pluggable). */

export interface Score {
  scorer: string;
  pass: boolean;
  detail?: Record<string, unknown>;
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export function exactMatch(name: string, actual: unknown, expected: unknown): Score {
  return { scorer: name, pass: JSON.stringify(actual) === JSON.stringify(expected), detail: { actual, expected } };
}

export function normalizedFieldMatch(name: string, actual: string, expected: string): Score {
  return { scorer: name, pass: normalize(actual) === normalize(expected), detail: { actual, expected } };
}

/** Numeric tolerance in ₹ (default ±1 per §7.4). */
export function numericTolerance(
  name: string,
  actual: number | null | undefined,
  expected: number,
  toleranceInr = 1,
): Score {
  if (actual == null || !Number.isFinite(actual)) {
    return { scorer: name, pass: false, detail: { actual, expected, toleranceInr } };
  }
  const diff = Math.abs(actual - expected);
  return { scorer: name, pass: diff <= toleranceInr, detail: { actual, expected, diff, toleranceInr } };
}

/** Set match for line items: same members regardless of order. */
export function setMatch(name: string, actual: string[], expected: string[]): Score {
  const a = [...actual].map(normalize).sort();
  const e = [...expected].map(normalize).sort();
  return { scorer: name, pass: a.length === e.length && a.every((v, i) => v === e[i]), detail: { actual: a, expected: e } };
}

/** Decision match: agent's proposed mode/state equals the human/golden label. */
export function decisionMatch(name: string, actual: string, expected: string): Score {
  return { scorer: name, pass: normalize(actual) === normalize(expected), detail: { actual, expected } };
}

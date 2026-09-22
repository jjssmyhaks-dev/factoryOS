/**
 * E0-S3: trace context is propagated through SQS message attributes so one
 * API request → enqueue → worker run is a single trace. We use the W3C
 * traceparent header format carried in a `traceparent` message attribute —
 * independent of any OTel SDK so it works the same in Lambda, tests and CI.
 */

export interface TraceContext {
  traceId: string;
  parentSpanId: string;
  sampled: boolean;
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function parseTraceparent(value: string | undefined): TraceContext | undefined {
  if (!value) return undefined;
  const m = TRACEPARENT_RE.exec(value.trim());
  if (!m) return undefined;
  const [, traceId, spanId, flags] = m;
  if (!traceId || !spanId || traceId === "0".repeat(32) || spanId === "0".repeat(16)) return undefined;
  return { traceId, parentSpanId: spanId, sampled: (parseInt(flags ?? "00", 16) & 0x01) === 1 };
}

export function formatTraceparent(ctx: TraceContext): string {
  const flags = ctx.sampled ? "01" : "00";
  return `00-${ctx.traceId}-${ctx.parentSpanId}-${flags}`;
}

export function randomTraceId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomSpanId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** SQS message attribute shape for the AWS SDK v3. */
export interface MessageAttribute {
  DataType: "String";
  StringValue: string;
}

export function toMessageAttributes(ctx: TraceContext): Record<string, MessageAttribute> {
  return { traceparent: { DataType: "String", StringValue: formatTraceparent(ctx) } };
}

export function fromMessageAttributes(
  attrs: Record<string, { StringValue?: string } | undefined> | undefined,
): TraceContext | undefined {
  return parseTraceparent(attrs?.traceparent?.StringValue);
}

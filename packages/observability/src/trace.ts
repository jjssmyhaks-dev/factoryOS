/**
 * Trace schema (§7.2): every agent run is one OpenTelemetry trace; every step
 * is a span with these attributes. We depend only on @opentelemetry/api — the
 * ADOT Lambda layer provides the SDK in AWS; tests can use the in-memory
 * exporter from sdk-trace-base.
 */

import { context, trace, type Span, type SpanAttributes } from "@opentelemetry/api";

export const TRACE_ATTRIBUTES = [
  "tenant_id",
  "run_id",
  "agent_id",
  "agent_version",
  "step_kind",
  "step_name",
  "model",
  "prompt_version",
  "input_tokens",
  "output_tokens",
  "latency_ms",
  "cost_inr",
  "tool_name",
  "outcome",
  "action_id",
  "mode",
] as const;

export type TraceAttribute = (typeof TRACE_ATTRIBUTES)[number];

export type StepAttributes = {
  tenant_id: string;
  run_id: string;
  agent_id: string;
  agent_version: string;
  step_kind: "llm" | "tool" | "validator" | "policy" | "human";
  step_name: string;
  model?: string;
  prompt_version?: string;
  input_tokens?: number;
  output_tokens?: number;
  latency_ms?: number;
  cost_inr?: number;
  tool_name?: string;
  outcome?: "ok" | "invalid" | "error" | "blocked";
  action_id?: string;
  mode?: string;
};

export function getTracer(name = "factory-ai-os") {
  return trace.getTracer(name);
}

/** Start a step span with the §7.2 attribute set. */
export function startStepSpan(spanName: string, attrs: StepAttributes): Span {
  return getTracer().startSpan(spanName, { attributes: attrs as SpanAttributes });
}

/** Measure a function, attach latency/outcome to the span, rethrow on error. */
export async function withStepSpan<T>(
  spanName: string,
  attrs: StepAttributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const span = startStepSpan(spanName, attrs);
  const started = Date.now();
  try {
    const result = await fn(span);
    span.setAttribute("latency_ms", Date.now() - started);
    if (!attrs.outcome) span.setAttribute("outcome", "ok");
    return result;
  } catch (err) {
    span.setAttribute("latency_ms", Date.now() - started);
    span.setAttribute("outcome", "error");
    span.recordException(err instanceof Error ? err : new Error(String(err)));
    throw err;
  } finally {
    span.end();
  }
}

/** W3C traceparent for the *current* context, for stitching across queues. */
export function currentTraceId(): string | undefined {
  const span = trace.getSpan(context.active());
  const sc = span?.spanContext();
  if (sc && sc.traceId && sc.traceId !== "0".repeat(32)) return sc.traceId;
  return undefined;
}

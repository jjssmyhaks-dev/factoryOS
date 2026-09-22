import { z } from "zod";
import {
  demoAgentDefinition,
  runDemoAgent,
  type AgentStore,
} from "@factory/agents";
import { decide, type TenantActionPolicy, type TenantPolicyFlags } from "@factory/harness";
import type { ModelProvider } from "@factory/llm";
import {
  createLogger,
  fromMessageAttributes,
  randomSpanId,
  withStepSpan,
  type ErrorReporter,
  type Logger,
} from "@factory/observability";

/**
 * Agent-run worker (E0-S3 tail of the trace, §4.3 "worker Lambdas").
 * Consumes queue messages, extracts the `traceparent` message attribute so
 * the run shares the API's trace, and executes the agent inside a traced
 * span. Failures are reported and rethrown → SQS retry → DLQ (§8.1).
 */

export const agentRunMessageSchema = z.object({
  channel: z.literal("agent-run"),
  tenant_id: z.string().min(1),
  request_id: z.string().optional(),
  idempotency_key: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export type AgentRunMessage = z.infer<typeof agentRunMessageSchema>;

export interface AgentRunDeps {
  store: AgentStore;
  llm: ModelProvider;
  flags: TenantPolicyFlags;
  tenantPolicy: TenantActionPolicy;
  logger?: Logger;
  reporter?: ErrorReporter;
  now?: () => Date;
}

/** One queue message → one traced agent run. Returns the run id. */
export async function handleAgentRunMessage(
  deps: AgentRunDeps,
  message: unknown,
  messageAttributes?: Record<string, unknown> | undefined,
): Promise<{ run_id: string; status: "succeeded" }> {
  const parsed = agentRunMessageSchema.parse(message);
  const log = deps.logger ?? createLogger({ level: "info" });
  const traceCtx = fromMessageAttributes(
    normalizeAttributes(messageAttributes as Record<string, { StringValue?: string }> | undefined),
  );

  const logger = log.child({
    tenant_id: parsed.tenant_id,
    ...(parsed.request_id ? { request_id: parsed.request_id } : {}),
    ...(traceCtx ? { trace_id: traceCtx.traceId } : {}),
  });

  const documentText = String(parsed.payload["text"] ?? parsed.payload["document_text"] ?? "");
  if (!documentText) {
    logger.warn("agent-run message missing document text");
    throw new Error("agent-run payload missing text");
  }

  const started = Date.now();
  const result = await withStepSpan(
    "agent.run",
    {
      tenant_id: parsed.tenant_id,
      run_id: "pending",
      agent_id: demoAgentDefinition.id,
      agent_version: demoAgentDefinition.version,
      step_kind: "llm",
      step_name: "agent_run",
      outcome: "ok",
    },
    async (span) => {
      const run = await runDemoAgent(
        {
          store: deps.store,
          llm: deps.llm,
          ...(deps.now ? { now: deps.now } : {}),
          flags: deps.flags,
          tenantPolicy: deps.tenantPolicy,
        },
        { tenant_id: parsed.tenant_id, document: { text: documentText } },
      );
      span.setAttribute("run_id", run.run_id);
      span.setAttribute("cost_inr", run.costInr);
      span.setAttribute("mode", run.decision?.mode ?? "none");
      return run;
    },
  );

  logger.info("agent run complete", {
    run_id: result.run_id,
    mode: result.decision?.mode ?? null,
    cost_inr: result.costInr,
    latency_ms: Date.now() - started,
  });

  return { run_id: result.run_id, status: "succeeded" };
}

interface StringValueHolder {
  StringValue?: string;
}

function normalizeAttributes(
  attrs: Record<string, StringValueHolder> | undefined,
): Record<string, StringValueHolder> | undefined {
  return attrs;
}

/** Re-exported for the policy sanity check in tests. */
export { decide, randomSpanId };

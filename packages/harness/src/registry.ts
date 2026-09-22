import { z } from "zod";
import type { Risk, SideEffect } from "@factory/domain";

/**
 * E6-S1 tool registry. Tools are defined once with zod schemas and appear
 * both to agents and in an MCP server listing with required scopes.
 * Invalid input is rejected and traced. Tools without a `dryRun` cannot be
 * registered as `external_write` (§6.1).
 */

export interface ToolCtx {
  tenant_id: string;
  run_id?: string;
  action_id?: string;
  actor_type: "user" | "agent" | "connector" | "system";
  actor_id?: string;
}

export interface DryRunResult {
  ok: boolean;
  reason?: string;
  preview?: unknown;
}

export interface VerifyResult {
  ok: boolean;
  details?: Record<string, unknown>;
}

export interface ToolDefinition<I = unknown, O = unknown> {
  name: string; // 'tally.post_purchase_voucher'
  description: string;
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  sideEffect: SideEffect;
  actionType: string; // key into autonomy policy
  risk: Risk;
  requiredScopes: string[];
  idempotencyKey(input: I): string;
  dryRun?(ctx: ToolCtx, input: I): Promise<DryRunResult>; // mandatory for external_write
  execute(ctx: ToolCtx, input: I): Promise<O>;
  verify?(ctx: ToolCtx, input: I, out: O): Promise<VerifyResult>;
  compensate?(ctx: ToolCtx, input: I, out: O): Promise<void>; // reversal
}

export type RegistryEvent =
  | { type: "tool.registered"; tool: string }
  | { type: "tool.input_invalid"; tool: string; error: string }
  | { type: "tool.executed"; tool: string; idempotency_key: string; outcome: "ok" | "error" };

export class ToolRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRegistryError";
  }
}

const TOOL_NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export interface RegistryOptions {
  /** Trace hook — every rejection and execution is traced (§7.2). */
  onEvent?: (event: RegistryEvent) => void;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(private readonly options: RegistryOptions = {}) {}

  register(tool: ToolDefinition): void {
    if (!TOOL_NAME_RE.test(tool.name)) {
      throw new ToolRegistryError(`invalid tool name (want domain.verb): ${tool.name}`);
    }
    if (this.tools.has(tool.name)) {
      throw new ToolRegistryError(`tool already registered: ${tool.name}`);
    }
    if (typeof (tool.inputSchema as { parse?: unknown }).parse !== "function") {
      throw new ToolRegistryError(`${tool.name}: inputSchema must be a zod schema`);
    }
    if (typeof (tool.outputSchema as { parse?: unknown }).parse !== "function") {
      throw new ToolRegistryError(`${tool.name}: outputSchema must be a zod schema`);
    }
    if (tool.sideEffect === "external_write" && !tool.dryRun) {
      throw new ToolRegistryError(
        `${tool.name}: external_write tools must implement dryRun (PRD §6.1)`,
      );
    }
    if (tool.sideEffect !== "none" && !tool.actionType) {
      throw new ToolRegistryError(`${tool.name}: actionType is required for side-effecting tools`);
    }
    this.tools.set(tool.name, tool as ToolDefinition);
    this.options.onEvent?.({ type: "tool.registered", tool: tool.name });
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): ToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolRegistryError(`unknown tool: ${name}`);
    return tool;
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  idempotencyKey(name: string, input: unknown): string {
    const tool = this.get(name);
    // Parse first: a key must be derived from validated input, and invalid
    // input is rejected + traced exactly like execute/dryRun.
    return tool.idempotencyKey(this.parseOrTrace(tool, input));
  }

  async dryRun(name: string, ctx: ToolCtx, input: unknown): Promise<DryRunResult> {
    const tool = this.get(name);
    const parsed = this.parseOrTrace(tool, input);
    if (!tool.dryRun) return { ok: true, reason: "no dryRun required" };
    return tool.dryRun(ctx, parsed);
  }

  /** Validates input (reject + trace on failure), then executes. */
  async execute(name: string, ctx: ToolCtx, input: unknown): Promise<unknown> {
    const tool = this.get(name);
    const parsed = this.parseOrTrace(tool, input);
    try {
      const out = await tool.execute(ctx, parsed);
      this.options.onEvent?.({
        type: "tool.executed",
        tool: name,
        idempotency_key: tool.idempotencyKey(parsed),
        outcome: "ok",
      });
      return tool.outputSchema.parse(out);
    } catch (err) {
      this.options.onEvent?.({
        type: "tool.executed",
        tool: name,
        idempotency_key: tool.idempotencyKey(parsed),
        outcome: "error",
      });
      throw err;
    }
  }

  private parseOrTrace(tool: ToolDefinition, input: unknown): unknown {
    const result = tool.inputSchema.safeParse(input);
    if (!result.success) {
      const error = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      this.options.onEvent?.({ type: "tool.input_invalid", tool: tool.name, error });
      throw new ToolRegistryError(`invalid input for ${tool.name}: ${error}`);
    }
    return result.data;
  }

  /**
   * MCP `tools/list` exposure (E3-S1/E6-S1): descriptions, JSON-schema
   * inputs (from zod), and hints derived from side effect / risk.
   */
  toMcpTools(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
    scopes: string[];
  }> {
    return this.list().map((tool) => {
      let inputSchema: Record<string, unknown> = {};
      try {
        inputSchema = z.toJSONSchema(tool.inputSchema, { io: "input" }) as Record<string, unknown>;
      } catch {
        // Older/newer zod variants: expose an empty schema rather than fail the listing.
      }
      return {
        name: tool.name,
        description: `[${tool.sideEffect}/${tool.risk}] ${tool.description}`,
        inputSchema,
        annotations: {
          readOnlyHint: tool.sideEffect === "none",
          destructiveHint: tool.sideEffect === "external_write" && tool.risk === "high",
        },
        scopes: tool.requiredScopes,
      };
    });
  }
}

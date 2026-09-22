import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ToolRegistry,
  ToolRegistryError,
  type RegistryEvent,
  type ToolDefinition,
} from "../src/registry.js";

const echoTool = {
  name: "test.echo",
  description: "Echoes a message (side-effect free).",
  inputSchema: z.object({ msg: z.string().min(1) }),
  outputSchema: z.object({ echo: z.string() }),
  sideEffect: "none",
  actionType: "extract.document",
  risk: "low",
  requiredScopes: ["test:read"],
  idempotencyKey: (i) => `echo:${i.msg}`,
  execute: async (_ctx, input) => ({ echo: input.msg }),
} satisfies ToolDefinition<{ msg: string }, { echo: string }>;

const postVoucher: ToolDefinition<{ total: number }, { guid: string }> = {
  name: "tally.post_purchase_voucher",
  description: "Posts a purchase voucher to Tally via the bridge.",
  inputSchema: z.object({ total: z.number().positive() }),
  outputSchema: z.object({ guid: z.string() }),
  sideEffect: "external_write",
  actionType: "tally.post_purchase_voucher",
  risk: "high",
  requiredScopes: ["tally:write"],
  idempotencyKey: (i) => `voucher:${i.total}`,
  dryRun: async () => ({ ok: true, preview: "INSERT VOUCHER" }),
  execute: async (_ctx, input) => ({ guid: `guid-${input.total}` }),
  compensate: async () => undefined,
};

describe("ToolRegistry registration", () => {
  it("registers a valid tool and traces the registration", () => {
    const events: RegistryEvent[] = [];
    const r = new ToolRegistry({ onEvent: (e) => events.push(e) });
    r.register(echoTool);
    expect(r.has("test.echo")).toBe(true);
    expect(events).toContainEqual({ type: "tool.registered", tool: "test.echo" });
  });

  it("rejects external_write without dryRun (§6.1)", () => {
    const r = new ToolRegistry();
    const { dryRun: _dropped, ...noDryRun } = postVoucher;
    expect(() => r.register(noDryRun as ToolDefinition)).toThrow(/must implement dryRun/);
  });

  it("rejects duplicates, bad names and non-zod schemas", () => {
    const r = new ToolRegistry();
    r.register(echoTool);
    expect(() => r.register(echoTool)).toThrow(/already registered/);
    expect(() =>
      r.register({ ...echoTool, name: "NoDots" }),
    ).toThrow(/invalid tool name/);
    expect(() =>
      r.register({ ...echoTool, name: "test.bad", inputSchema: {} as never }),
    ).toThrow(/zod schema/);
    expect(() =>
      r.register({ ...echoTool, name: "test.bad2", outputSchema: {} as never }),
    ).toThrow(/zod schema/);
  });

  it("requires an actionType for side-effecting tools", () => {
    const r = new ToolRegistry();
    expect(() =>
      r.register({ ...postVoucher, actionType: "" }),
    ).toThrow(/actionType is required/);
  });

  it("get() throws on unknown tools", () => {
    expect(() => new ToolRegistry().get("nope.no")).toThrow(/unknown tool/);
  });
});

describe("ToolRegistry execution", () => {
  it("validates input, executes, validates output", async () => {
    const events: RegistryEvent[] = [];
    const r = new ToolRegistry({ onEvent: (e) => events.push(e) });
    r.register(postVoucher);
    const out = await r.execute(
      "tally.post_purchase_voucher",
      { tenant_id: "t1", actor_type: "agent" },
      { total: 100 },
    );
    expect(out).toEqual({ guid: "guid-100" });
    expect(events).toContainEqual({
      type: "tool.executed",
      tool: "tally.post_purchase_voucher",
      idempotency_key: "voucher:100",
      outcome: "ok",
    });
  });

  it("rejects invalid input and traces it (E6-S1 AC)", async () => {
    const events: RegistryEvent[] = [];
    const r = new ToolRegistry({ onEvent: (e) => events.push(e) });
    r.register(postVoucher);
    await expect(
      r.execute("tally.post_purchase_voucher", { tenant_id: "t1", actor_type: "agent" }, { total: -5 }),
    ).rejects.toThrow(/invalid input/);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool.input_invalid", tool: "tally.post_purchase_voucher" }),
    );
  });

  it("traces execution errors with outcome=error", async () => {
    const events: RegistryEvent[] = [];
    const failing: ToolDefinition<{ x: number }, { y: number }> = {
      ...echoTool,
      name: "test.failing",
      inputSchema: z.object({ x: z.number() }),
      outputSchema: z.object({ y: z.number() }),
      idempotencyKey: (i) => `f:${i.x}`,
      execute: async () => {
        throw new Error("connector down");
      },
    };
    const r = new ToolRegistry({ onEvent: (e) => events.push(e) });
    r.register(failing);
    await expect(
      r.execute("test.failing", { tenant_id: "t1", actor_type: "agent" }, { x: 1 }),
    ).rejects.toThrow("connector down");
    expect(events).toContainEqual(expect.objectContaining({ type: "tool.executed", outcome: "error" }));
  });

  it("dryRun passes through validation and tool dryRun", async () => {
    const r = new ToolRegistry();
    r.register(postVoucher);
    const ok = await r.dryRun("tally.post_purchase_voucher", { tenant_id: "t1", actor_type: "agent" }, { total: 3 });
    expect(ok).toEqual({ ok: true, preview: "INSERT VOUCHER" });
    await expect(
      r.dryRun("tally.post_purchase_voucher", { tenant_id: "t1", actor_type: "agent" }, { total: -1 }),
    ).rejects.toThrow(/invalid input/);
    // tools without dryRun → ok: true
    r.register(echoTool);
    expect(await r.dryRun("test.echo", { tenant_id: "t1", actor_type: "agent" }, { msg: "x" })).toEqual({
      ok: true,
      reason: "no dryRun required",
    });
  });

  it("idempotencyKey helper parses input first", () => {
    const r = new ToolRegistry();
    r.register(postVoucher);
    expect(r.idempotencyKey("tally.post_purchase_voucher", { total: 9 })).toBe("voucher:9");
    expect(() => r.idempotencyKey("tally.post_purchase_voucher", {})).toThrow(/invalid input/);
  });

  it("output schema violations propagate", async () => {
    const badOutput: ToolDefinition<{ x: number }, { y: number }> = {
      ...echoTool,
      name: "test.bad_output",
      inputSchema: z.object({ x: z.number() }),
      outputSchema: z.object({ y: z.number() }),
      idempotencyKey: (i) => `b:${i.x}`,
      execute: async () => ({ y: "not-a-number" as never }),
    };
    const r = new ToolRegistry();
    r.register(badOutput);
    await expect(
      r.execute("test.bad_output", { tenant_id: "t1", actor_type: "agent" }, { x: 1 }),
    ).rejects.toThrow();
  });
});

describe("MCP exposure (E3-S1)", () => {
  it("lists tools with JSON-schema inputs, scopes and hints", () => {
    const r = new ToolRegistry();
    r.register(echoTool);
    r.register(postVoucher);
    const list = r.toMcpTools();
    expect(list).toHaveLength(2);
    const echo = list.find((t) => t.name === "test.echo")!;
    expect(echo.inputSchema).toMatchObject({ type: "object" });
    expect(echo.scopes).toEqual(["test:read"]);
    expect(echo.annotations?.readOnlyHint).toBe(true);
    const voucher = list.find((t) => t.name === "tally.post_purchase_voucher")!;
    expect(voucher.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(voucher.description).toContain("[external_write/high]");
  });

  it("does not throw when a schema cannot be converted", () => {
    const weird: ToolDefinition<{ x: number }, { x: number }> = {
      ...echoTool,
      name: "test.weird",
      inputSchema: z.object({ x: z.number() }).refine(() => true) as never,
      outputSchema: z.object({ x: z.number() }),
      idempotencyKey: () => "w",
      execute: async (_ctx, input) => input,
    };
    const r = new ToolRegistry();
    r.register(weird);
    expect(() => r.toMcpTools()).not.toThrow();
    expect(r.toMcpTools()[0]!.name).toBe("test.weird");
  });
});

describe("ToolRegistryError", () => {
  it("is an Error with a name", () => {
    expect(new ToolRegistryError("x")).toBeInstanceOf(Error);
    expect(new ToolRegistryError("x").name).toBe("ToolRegistryError");
  });
});

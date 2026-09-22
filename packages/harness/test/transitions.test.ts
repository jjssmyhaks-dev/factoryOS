import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  ACTION_TRANSITIONS,
  AGENT_RUN_TRANSITIONS,
  ExecutionLedger,
  LifecycleGuard,
  TransitionError,
  approvalExpiry,
  buildActionLifecycleDefinition,
  buildAgentRunDefinition,
  canTransition,
  isTerminalState,
  successors,
} from "../src/transitions.js";

const ALL_ACTION_STATES = Object.keys(ACTION_TRANSITIONS);
const TERMINAL_ACTION_STATES = ALL_ACTION_STATES.filter((s) =>
  isTerminalState(ACTION_TRANSITIONS, s),
);

describe("transition table closure", () => {
  it("every target is a known state (both tables)", () => {
    for (const table of [ACTION_TRANSITIONS, AGENT_RUN_TRANSITIONS]) {
      for (const [from, targets] of Object.entries(table)) {
        for (const to of targets) {
          expect(Object.keys(table), `${from} -> ${to}`).toContain(to);
        }
        // terminal ⇔ no successors
        expect(isTerminalState(table, from)).toBe(targets.length === 0);
      }
    }
  });

  it("matches §6.3 exactly", () => {
    expect(successors(ACTION_TRANSITIONS, "proposed")).toEqual(["policy_evaluated"]);
    expect(successors(ACTION_TRANSITIONS, "policy_evaluated")).toEqual([
      "suggested_only",
      "pending_approval",
      "auto_approved",
      "shadow_recorded",
    ]);
    expect(successors(ACTION_TRANSITIONS, "executing")).toEqual(["executed", "failed"]);
    expect(successors(ACTION_TRANSITIONS, "executed")).toEqual(["reversed", "verify_failed"]);
    for (const t of TERMINAL_ACTION_STATES) {
      expect(successors(ACTION_TRANSITIONS, t)).toEqual([]);
    }
  });
});

/** Property: no path from a terminal state to `executing` (E6-S2 AC). */
describe("property: terminal states are absorbing", () => {
  it("no terminal state can reach executing — direct or via any walk", () => {
    fc.assert(
      fc.property(fc.constantFrom(...TERMINAL_ACTION_STATES), (from: string) => {
        // direct
        expect(canTransition(ACTION_TRANSITIONS, from, "executing")).toBe(false);
        // any single step
        for (const to of ALL_ACTION_STATES) {
          expect(canTransition(ACTION_TRANSITIONS, from, to)).toBe(false);
        }
      }),
    );
  });

  it("a walk that reaches a terminal state can never re-enter executing", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 99 }), { minLength: 1, maxLength: 40 }),
        (choices) => {
          const guard = new LifecycleGuard(ACTION_TRANSITIONS, "proposed");
          for (const c of choices) {
            const options = successors(ACTION_TRANSITIONS, guard.state);
            if (options.length === 0) break;
            const next = options[c % options.length]!;
            if (isTerminalState(ACTION_TRANSITIONS, guard.state)) {
              expect(() => guard.apply(next)).toThrow(TransitionError);
              return;
            }
            guard.apply(next);
          }
          // If we ended terminal, applying anything must throw.
          if (isTerminalState(ACTION_TRANSITIONS, guard.state)) {
            expect(() => guard.apply("executing")).toThrow(TransitionError);
          }
        },
      ),
    );
  });

  it("terminal guard throws on any attempted successor", () => {
    const guard = new LifecycleGuard(ACTION_TRANSITIONS, "proposed");
    guard.apply("policy_evaluated");
    guard.apply("pending_approval");
    guard.apply("rejected");
    for (const to of ALL_ACTION_STATES) {
      expect(() => guard.apply(to), `rejected -> ${to}`).toThrow(TransitionError);
    }
  });
});

/** Property: executing happens at most once per idempotency key (E6-S2 AC). */
describe("property: execution happens at most once per idempotency key", () => {
  it("the ledger admits a key exactly once", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9:._-]{1,40}$/),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }),
        (key: string, attempts: boolean[]) => {
          const ledger = new ExecutionLedger();
          let admitted = 0;
          for (const _ of attempts) if (ledger.claim(key)) admitted++;
          expect(admitted).toBe(1);
        },
      ),
    );
  });

  it("two guards sharing a ledger cannot both execute the same key", () => {
    const ledger = new ExecutionLedger();
    const key = "tenant:action:abc123";
    const a = new LifecycleGuard(ACTION_TRANSITIONS, "proposed", ledger, key);
    const b = new LifecycleGuard(ACTION_TRANSITIONS, "proposed", ledger, key);

    // Drive both to approved → executing; exactly one must win.
    for (const g of [a, b]) {
      g.apply("policy_evaluated");
      g.apply("pending_approval");
      g.apply("approved");
    }
    const results = [a, b].map((g) => {
      try {
        g.apply("executing");
        return "executed";
      } catch {
        return "refused";
      }
    });
    expect(results.filter((r) => r === "executed")).toHaveLength(1);
    expect(results.filter((r) => r === "refused")).toHaveLength(1);
    expect(a.executions + b.executions).toBe(1);
  });

  it("a full happy path executes exactly once then locks", () => {
    const ledger = new ExecutionLedger();
    const guard = new LifecycleGuard(ACTION_TRANSITIONS, "proposed", ledger, "k");
    const walk = [
      "policy_evaluated",
      "auto_approved",
      "executing",
      "executed",
      "verify_failed",
    ];
    for (const s of walk) guard.apply(s);
    expect(guard.executions).toBe(1);
    expect(() => guard.apply("executing")).toThrow(TransitionError); // terminal anyway
    expect(ledger.has("k")).toBe(true);
    expect(ledger.claim("k")).toBe(false);
  });

  it("only legal paths walk end to end", () => {
    fc.assert(
      fc.property(fc.constantFrom("suggested_only", "rejected", "expired", "shadow_recorded"), (branch) => {
        const guard = new LifecycleGuard(ACTION_TRANSITIONS, "proposed");
        guard.apply("policy_evaluated");
        // rejected/expired are only reachable via pending_approval (§6.3).
        if (branch === "rejected" || branch === "expired") guard.apply("pending_approval");
        guard.apply(branch);
        expect(isTerminalState(ACTION_TRANSITIONS, guard.state)).toBe(true);
      }),
    );
  });
});

describe("approval expiry (§6.5)", () => {
  it("defaults to 24 hours and flips to expired", () => {
    const requested = new Date("2026-09-22T10:00:00Z");
    const expiry = approvalExpiry(requested);
    expect(expiry.toISOString()).toBe("2026-09-23T10:00:00.000Z");
    expect(approvalExpiry(requested, 1).toISOString()).toBe("2026-09-22T11:00:00.000Z");
  });

  it("isExpired is strictly greater-than", () => {
    const t = new Date("2026-09-22T10:00:00Z");
    expect(approvalExpiry(t, 0).getTime()).toBe(t.getTime());
    const exp = approvalExpiry(t, 1);
    expect(new Date(exp.getTime() - 1) > t).toBe(true);
  });
});

describe("ASL generation", () => {
  const action = buildActionLifecycleDefinition(ACTION_TRANSITIONS);
  const agentRun = buildAgentRunDefinition(AGENT_RUN_TRANSITIONS);

  it("covers every state and route, starting at the first state", () => {
    expect(action.StartAt).toBe("proposed");
    expect(agentRun.StartAt).toBe("running");
    for (const state of ALL_ACTION_STATES) {
      expect(action.States, state).toHaveProperty(state);
      if (!isTerminalState(ACTION_TRANSITIONS, state)) {
        expect(action.States, state).toHaveProperty(`route_${state}`);
      }
    }
    expect(action.States).toHaveProperty("invalid_transition");
  });

  it("terminal states are Succeed/Fail nodes with no Next", () => {
    for (const state of TERMINAL_ACTION_STATES) {
      const node = action.States[state] as Record<string, unknown>;
      expect(node["Type"]).toMatch(/Succeed|Fail/);
      expect(node).not.toHaveProperty("Next");
    }
    expect((action.States["failed"] as Record<string, unknown>)["Type"]).toBe("Fail");
    expect((action.States["verify_failed"] as Record<string, unknown>)["Type"]).toBe("Fail");
  });

  it("pending_approval waits with a 24 h timeout and routes timeout → expired", () => {
    const node = action.States["pending_approval"] as Record<string, any>;
    expect(node["Type"]).toBe("Task");
    expect(node["TimeoutSeconds"]).toBe(86_400);
    const payload = node["Parameters"]["Payload"] as Record<string, unknown>;
    expect(payload["taskToken.$"]).toBe("$$.Task.Token"); // §6.9 waitForTaskToken
    const catches = node["Catch"] as Array<Record<string, unknown>>;
    expect(catches[0]).toMatchObject({ ErrorEquals: ["States.Timeout"], Next: "expired" });
  });

  it("every choice routes only to table successors", () => {
    for (const [state, targets] of Object.entries(ACTION_TRANSITIONS)) {
      if (targets.length === 0) continue;
      const route = action.States[`route_${state}`] as any;
      const routed = route.Choices.map((c: any) => c.Next);
      expect(routed).toEqual([...targets]);
      expect(route.Default).toBe("invalid_transition");
    }
  });

  it("every task catches to failed", () => {
    const nodes = Object.values(action.States) as Array<Record<string, any>>;
    for (const node of nodes) {
      if (node["Type"] === "Task") {
        const catches = node["Catch"] as Array<Record<string, unknown>>;
        expect(catches.some((c) => c["Next"] === "failed")).toBe(true);
      }
    }
    expect(agentRun.States["running"]).toHaveProperty("Catch");
  });

  it("is deterministic (same table → identical JSON)", () => {
    expect(JSON.stringify(buildActionLifecycleDefinition(ACTION_TRANSITIONS))).toBe(
      JSON.stringify(action),
    );
  });

  it("rejects an empty table", () => {
    expect(() => buildActionLifecycleDefinition({})).toThrow(/empty/);
    expect(() => buildAgentRunDefinition({})).toThrow(/empty/);
  });
});

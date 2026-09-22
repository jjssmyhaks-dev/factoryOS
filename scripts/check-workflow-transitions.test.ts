import { describe, expect, it } from "vitest";
import {
  ACTION_TRANSITIONS,
  AGENT_RUN_TRANSITIONS,
  buildActionLifecycleDefinition,
  buildAgentRunDefinition,
} from "../packages/harness/src/transitions.js";

/**
 * The CI gate (scripts/check-workflow-transitions.ts) executes the same
 * invariants programmatically; these tests pin them here so `pnpm test`
 * catches regressions without invoking the script.
 */
describe("workflow definitions vs transition table (§6.9)", () => {
  it("table is closed and terminals have no successors", () => {
    for (const table of [ACTION_TRANSITIONS, AGENT_RUN_TRANSITIONS]) {
      for (const [from, targets] of Object.entries(table)) {
        for (const to of targets) {
          expect(Object.keys(table)).toContain(to);
        }
        expect(targets.length === 0).toBe(from in terminalSet(table));
      }
    }
  });

  function terminalSet(table: Record<string, readonly string[]>): Record<string, true> {
    const out: Record<string, true> = {};
    for (const [k, v] of Object.entries(table)) if (v.length === 0) out[k] = true;
    return out;
  }

  it("action-lifecycle and agent-run definitions are generated", () => {
    const action = buildActionLifecycleDefinition(ACTION_TRANSITIONS);
    const run = buildAgentRunDefinition(AGENT_RUN_TRANSITIONS);
    expect(action.StartAt).toBe("proposed");
    expect(run.StartAt).toBe("running");
    expect(Object.keys(action.States)).toContain("pending_approval");
    expect((action.States["pending_approval"] as any).TimeoutSeconds).toBe(86_400);
  });
});

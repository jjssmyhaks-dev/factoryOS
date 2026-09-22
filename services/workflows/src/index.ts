import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACTION_TRANSITIONS,
  AGENT_RUN_TRANSITIONS,
  buildActionLifecycleDefinition,
  buildAgentRunDefinition,
  type SfnDefinition,
} from "@factory/harness";

/**
 * Step Functions definitions (§6.9) are GENERATED from the transition table
 * in `packages/harness` — `scripts/generate-workflows.ts` writes `asl/*.json`
 * and `scripts/check-workflow-transitions.ts` fails CI when they diverge.
 *
 * Two workflows:
 *  - action-lifecycle: proposed → policy_evaluated → … (waitForTaskToken on
 *    pending_approval, 24 h timeout → expired).
 *  - agent-run: running → succeeded | failed | cancelled.
 *
 * Workflows carry identifiers only; Postgres is the state of record.
 */

export const ASL_DIR = join(import.meta.dirname, "..", "asl");

export function loadAsl(name: "action-lifecycle" | "agent-run"): SfnDefinition {
  return JSON.parse(readFileSync(join(ASL_DIR, `${name}.json`), "utf8")) as SfnDefinition;
}

/** In-memory generation (used by tests to compare against disk). */
export function generatedAsl(): Record<string, SfnDefinition> {
  return {
    "action-lifecycle.json": buildActionLifecycleDefinition(ACTION_TRANSITIONS),
    "agent-run.json": buildAgentRunDefinition(AGENT_RUN_TRANSITIONS),
  };
}

export { ACTION_TRANSITIONS, AGENT_RUN_TRANSITIONS };

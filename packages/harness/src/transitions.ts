/**
 * §6.3 persisted action lifecycle + §6.9 agent-run states as a transition
 * table. This table is the single source of truth: the Step Functions ASL
 * definitions are generated from it (scripts/generate-workflows.ts) and CI
 * fails if they diverge (scripts/check-workflow-transitions.ts).
 *
 * Table rules (verified by tests + the CI script):
 * - Every target must be a known state.
 * - Terminal states have no successors.
 * - No path from a terminal state to `executing`.
 */

export type TransitionTable = Record<string, readonly string[]>;

/** Action lifecycle (§6.3). */
export const ACTION_TRANSITIONS: TransitionTable = {
  proposed: ["policy_evaluated"],
  policy_evaluated: [
    "suggested_only",
    "pending_approval",
    "auto_approved",
    "shadow_recorded",
  ],
  pending_approval: ["approved", "rejected", "expired"],
  approved: ["executing"],
  auto_approved: ["executing"],
  executing: ["executed", "failed"],
  executed: ["reversed", "verify_failed"],
  // terminal:
  suggested_only: [],
  rejected: [],
  expired: [],
  shadow_recorded: [],
  reversed: [],
  failed: [],
  verify_failed: [],
};

/** Agent run lifecycle (§5.2 `agent_runs.status`). */
export const AGENT_RUN_TRANSITIONS: TransitionTable = {
  running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function isKnownState(table: TransitionTable, state: string): boolean {
  return Object.prototype.hasOwnProperty.call(table, state);
}

export function isTerminalState(table: TransitionTable, state: string): boolean {
  const targets = table[state];
  return isKnownState(table, state) && targets !== undefined && targets.length === 0;
}

export function canTransition(table: TransitionTable, from: string, to: string): boolean {
  const targets = table[from];
  return targets !== undefined && targets.includes(to);
}

export function successors(table: TransitionTable, from: string): readonly string[] {
  return table[from] ?? [];
}

export class TransitionError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`illegal transition: ${from} -> ${to}`);
    this.name = "TransitionError";
  }
}

/**
 * E6-S2 invariant: executing happens at most once per
 * (tenant_id, idempotency_key). The DB unique constraint is the final guard;
 * this ledger makes duplicate workflow executions no-op locally too.
 */
export class ExecutionLedger {
  private readonly executed = new Set<string>();

  /** Returns false when this key has already claimed execution. */
  claim(idempotencyKey: string): boolean {
    if (this.executed.has(idempotencyKey)) return false;
    this.executed.add(idempotencyKey);
    return true;
  }

  has(idempotencyKey: string): boolean {
    return this.executed.has(idempotencyKey);
  }
}

/** Applies transitions with terminal-state and at-most-once guards. */
export class LifecycleGuard {
  private current: string;
  private enteredExecuting = 0;

  constructor(
    private readonly table: TransitionTable,
    start: string,
    private readonly ledger: ExecutionLedger = new ExecutionLedger(),
    private readonly idempotencyKey: string = "_single",
  ) {
    if (!isKnownState(table, start)) throw new Error(`unknown start state: ${start}`);
    this.current = start;
  }

  get state(): string {
    return this.current;
  }

  get executions(): number {
    return this.enteredExecuting;
  }

  apply(to: string): void {
    if (isTerminalState(this.table, this.current)) {
      throw new TransitionError(this.current, to); // terminal → anything is illegal
    }
    if (!canTransition(this.table, this.current, to)) {
      throw new TransitionError(this.current, to);
    }
    if (to === "executing") {
      if (!this.ledger.claim(this.idempotencyKey)) {
        throw new TransitionError(this.current, to); // duplicate execution attempt
      }
      this.enteredExecuting++;
    }
    this.current = to;
  }
}

/** Approval tokens expire in 24 h by default (§6.5); configurable. */
export function approvalExpiry(requestedAt: Date, ttlHours = 24): Date {
  return new Date(requestedAt.getTime() + ttlHours * 3_600_000);
}

export function isExpired(expiry: Date, now: Date): boolean {
  return now.getTime() > expiry.getTime();
}

// ---------------------------------------------------------------------------
// Step Functions ASL generation (§6.9)
// ---------------------------------------------------------------------------

export interface SfnDefinition {
  Comment: string;
  StartAt: string;
  States: Record<string, unknown>;
}

const STEP_FUNCTION_NAME = "factory-ai-os-step"; // E6-S2 wires real ARNs at deploy time

function terminalNode(state: string): unknown {
  if (state === "failed" || state === "verify_failed") {
    return { Type: "Fail", Error: state, Cause: `terminal state: ${state} (alert is raised by the step handler)` };
  }
  return { Type: "Succeed" };
}

function routeNode(state: string, targets: readonly string[]): unknown {
  return {
    Type: "Choice",
    Choices: targets.map((t) => ({ Variable: "$.step_result.next", StringEquals: t, Next: t })),
    Default: "invalid_transition",
  };
}

function taskNode(state: string, opts: { waitForApproval?: boolean } = {}): unknown {
  const payload: Record<string, unknown> = {
    "action_id.$": "$.action_id",
    "tenant_id.$": "$.tenant_id",
    target_state: state,
  };
  const node: Record<string, unknown> = {
    Type: "Task",
    Resource: "arn:aws:states:::lambda:invoke",
    Parameters: { FunctionName: STEP_FUNCTION_NAME, Payload: payload },
    ResultPath: "$.step_result",
    Retry: [
      { ErrorEquals: ["States.TaskFailed"], IntervalSeconds: 2, MaxAttempts: 2, BackoffRate: 2 },
    ],
    Catch: [{ ErrorEquals: ["States.ALL"], ResultPath: "$.error", Next: "failed" }],
    Next: `route_${state}`,
  };
  if (opts.waitForApproval) {
    // §6.9 approval wait: task token travels with the payload; the approval
    // webhook validates the signed token then calls SendTaskSuccess/Failure.
    // A timeout routes to `expired` (§6.3).
    (payload as Record<string, unknown>)["taskToken.$"] = "$$.Task.Token";
    node["TimeoutSeconds"] = 86_400; // default 24 h (§6.5)
    node["Catch"] = [
      { ErrorEquals: ["States.Timeout"], ResultPath: "$.error", Next: "expired" },
      { ErrorEquals: ["States.ALL"], ResultPath: "$.error", Next: "failed" },
    ];
  } else {
    node["TimeoutSeconds"] = 300;
    node["HeartbeatSeconds"] = 60;
  }
  return node;
}

/** Generates the action-lifecycle ASL from a §6.3 transition table. */
export function buildActionLifecycleDefinition(table: TransitionTable): SfnDefinition {
  const states: Record<string, unknown> = {};
  const first = Object.keys(table)[0];
  if (!first) throw new Error("empty transition table");

  for (const [state, targets] of Object.entries(table)) {
    if (targets.length === 0) {
      states[state] = terminalNode(state);
      continue;
    }
    const wait = state === "pending_approval";
    states[state] = taskNode(state, { waitForApproval: wait });
    states[`route_${state}`] = routeNode(state, targets);
  }
  states["invalid_transition"] = {
    Type: "Fail",
    Error: "InvalidTransition",
    Cause: "step handler returned a successor that is not in the transition table",
  };

  return {
    Comment:
      "ACTION LIFECYCLE (PRD §6.3) — GENERATED from packages/harness/src/transitions.ts; do not edit by hand; run: tsx scripts/generate-workflows.ts",
    StartAt: first,
    States: states,
  };
}

/** Generates the agent-run ASL from the §5.2 status table. */
export function buildAgentRunDefinition(table: TransitionTable): SfnDefinition {
  const states: Record<string, unknown> = {};
  const first = Object.keys(table)[0];
  if (!first) throw new Error("empty transition table");

  for (const [state, targets] of Object.entries(table)) {
    if (targets.length === 0) {
      states[state] = terminalNode(state === "failed" ? "failed" : state);
      continue;
    }
    states[state] = {
      Type: "Task",
      Resource: "arn:aws:states:::lambda:invoke",
      Parameters: {
        FunctionName: STEP_FUNCTION_NAME,
        Payload: { "run_id.$": "$.run_id", "tenant_id.$": "$.tenant_id", target_state: state },
      },
      ResultPath: "$.step_result",
      TimeoutSeconds: 900, // LLM step budget < Lambda 15 min cap (§4.3)
      HeartbeatSeconds: 120,
      Retry: [{ ErrorEquals: ["States.TaskFailed"], IntervalSeconds: 2, MaxAttempts: 1, BackoffRate: 2 }],
      Catch: [{ ErrorEquals: ["States.ALL"], ResultPath: "$.error", Next: "failed" }],
      Next: `route_${state}`,
    };
    states[`route_${state}`] = routeNode(state, targets);
  }
  states["invalid_transition"] = {
    Type: "Fail",
    Error: "InvalidTransition",
    Cause: "step handler returned a successor that is not in the transition table",
  };

  return {
    Comment:
      "AGENT RUN (PRD §6.9) — GENERATED from packages/harness/src/transitions.ts; do not edit by hand; run: tsx scripts/generate-workflows.ts",
    StartAt: first,
    States: states,
  };
}

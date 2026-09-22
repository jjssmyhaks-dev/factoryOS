/**
 * E6-S2 consistency gate: the Step Functions definitions in
 * services/workflows/asl/*.json must be *generated from* the transition table
 * in packages/harness — CI fails if the workflow definition diverges.
 *
 * Regenerate with: tsx scripts/generate-workflows.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

async function main() {
  const { ACTION_TRANSITIONS, buildActionLifecycleDefinition } = await import("../packages/harness/src/transitions");
  const { AGENT_RUN_TRANSITIONS, buildAgentRunDefinition } = await import("../packages/harness/src/transitions");

  const dir = join(process.cwd(), "services/workflows/asl");
  const expected: Record<string, unknown> = {
    "action-lifecycle.json": buildActionLifecycleDefinition(ACTION_TRANSITIONS),
    "agent-run.json": buildAgentRunDefinition(AGENT_RUN_TRANSITIONS),
  };

  let failed = false;

  // 1. Every file on disk must match the generator output.
  const onDisk = readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const [name, definition] of Object.entries(expected)) {
    if (!onDisk.includes(name)) {
      console.error(`missing workflow definition: services/workflows/asl/${name} (run tsx scripts/generate-workflows.ts)`);
      failed = true;
      continue;
    }
    const actual = JSON.parse(readFileSync(join(dir, name), "utf8"));
    if (JSON.stringify(actual) !== JSON.stringify(definition)) {
      console.error(`workflow definition out of sync with transition table: services/workflows/asl/${name}`);
      failed = true;
    }
  }
  for (const f of onDisk) {
    if (!(f in expected)) {
      console.error(`unknown workflow definition (not generated from the transition table): services/workflows/asl/${f}`);
      failed = true;
    }
  }

  // 2. The table itself must be closed: every target of every transition must
  //    itself be a known state, and no terminal state may have successors.
  for (const [name, table] of [
    ["action-lifecycle", ACTION_TRANSITIONS],
    ["agent-run", AGENT_RUN_TRANSITIONS],
  ] as const) {
    for (const [from, targets] of Object.entries(table)) {
      for (const to of targets) {
        if (!(to in table)) {
          console.error(`${name}: transition ${from} -> ${to} targets an unknown state`);
          failed = true;
        }
      }
      const terminal = table[from]?.length === 0;
      if (terminal && (table as Record<string, string[]>)[from]?.length) {
        console.error(`${name}: terminal state ${from} has successors`);
        failed = true;
      }
    }
  }

  if (failed) process.exit(1);
  console.log("workflow/transition-table consistency: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

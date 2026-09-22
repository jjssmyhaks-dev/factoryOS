/**
 * Regenerates services/workflows/asl/*.json from the harness transition table
 * (single source of truth, PRD §6.9).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

async function main() {
  const { ACTION_TRANSITIONS, AGENT_RUN_TRANSITIONS, buildActionLifecycleDefinition, buildAgentRunDefinition } =
    await import("../packages/harness/src/transitions");
  const dir = join(process.cwd(), "services/workflows/asl");
  mkdirSync(dir, { recursive: true });
  const files: Array<[string, unknown]> = [
    ["action-lifecycle.json", buildActionLifecycleDefinition(ACTION_TRANSITIONS)],
    ["agent-run.json", buildAgentRunDefinition(AGENT_RUN_TRANSITIONS)],
  ];
  for (const [name, definition] of files) {
    writeFileSync(join(dir, name), `${JSON.stringify(definition, null, 2)}\n`);
    console.log(`wrote services/workflows/asl/${name}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

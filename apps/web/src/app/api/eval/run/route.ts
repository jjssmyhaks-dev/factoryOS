import { getRunnerState, startRun, type RunnerState } from "../../../../lib/eval-runner";

export const dynamic = "force-dynamic";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Current runner state (poll target for the dashboard). */
export function GET(): Response {
  return json(getRunnerState() satisfies RunnerState);
}

/** Runs the eval CLI to completion and returns the resulting view. */
export async function POST(): Promise<Response> {
  const view = await startRun();
  if (!view) return json({ started: false, state: getRunnerState() }, 202);
  return json({ started: true, state: getRunnerState(), view });
}

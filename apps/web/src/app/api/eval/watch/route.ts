import { getRunnerState } from "../../../../lib/eval-runner";
import { setWatch } from "../../../../lib/eval-watch";

export const dynamic = "force-dynamic";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function GET(): Response {
  return json(getRunnerState());
}

/** Toggle the packages/** file watcher: { enabled: boolean }. */
export async function POST(request: Request): Promise<Response> {
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const enabled = (body as { enabled?: unknown } | null)?.enabled;
  if (typeof enabled !== "boolean") {
    return json({ error: "expected { enabled: boolean }" }, 400);
  }
  setWatch(enabled);
  return json(getRunnerState());
}

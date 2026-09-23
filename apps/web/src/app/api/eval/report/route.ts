import { readLatestReportHtml } from "../../../../lib/eval-runner";

export const dynamic = "force-dynamic";

/** Serves the newest generated eval report HTML (dashboard iframe target). */
export function GET(): Response {
  const html = readLatestReportHtml();
  if (html === null) {
    return new Response("No eval report yet — run the gate from the dashboard.", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

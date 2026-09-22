import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { InMemoryQueue } from "./queue.js";
import { FlagCache } from "./flags-client.js";
import { createLogger } from "@factory/observability";

/**
 * Local dev server — runs the real app with in-memory fakes so E0-S1 works
 * on a clean clone with zero AWS credentials:
 *   JWT_SECRET=dev pnpm --filter @factory/api dev
 * Demo users are encoded in DEV_MEMBERSHIPS_JSON (default: one owner).
 */

const secret = process.env.JWT_SECRET ?? "dev-secret-do-not-use-in-prod";
const memberships = JSON.parse(
  process.env.DEV_MEMBERSHIPS_JSON ??
    '{"00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002":"owner"}',
) as Record<string, string>;

const queue = new InMemoryQueue();
const flags = new FlagCache(async () => ({}), 30_000);

const app = createApp({
  auth: {
    secret,
    lookupMembership: async (userId, tenantId) =>
      (memberships[`${userId}:${tenantId}`] as never) ?? null,
  },
  queue,
  flags,
  logger: createLogger({ level: "info" }),
});

const port = Number(process.env.PORT ?? 3000);
console.log(`api listening on http://localhost:${port} (in-memory queue)`); // eslint-disable-line no-console
serve({ fetch: app.fetch, port });

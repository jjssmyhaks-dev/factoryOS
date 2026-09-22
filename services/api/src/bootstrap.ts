import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { FlagCache } from "./flags-client.js";
import { createApp } from "./app.js";
import type { MembershipLookup } from "./auth.js";
import { SqsQueue } from "./queue.js";

/**
 * Boot wiring: everything comes from environment variables (AWS secrets are
 * referenced, never inlined — Global DoD §0.8). Membership lookup reads
 * `MEMBERSHIPS_JSON` in M0 (a stand-in until the Supabase project exists,
 * [VERIFY]/Q13); E1-S2 replaces it with a `memberships` table query.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env: ${name}`);
  return v;
}

export function bootstrap() {
  const jwtSecret = required("JWT_SECRET");
  const region = process.env.AWS_REGION ?? "ap-south-1";

  // memberships: JSON map of "userId:tenantId" → role (M0 stand-in).
  const membershipsTable = JSON.parse(process.env.MEMBERSHIPS_JSON ?? "{}") as Record<string, string>;
  const lookup: MembershipLookup = async (userId, tenantId) =>
    (membershipsTable[`${userId}:${tenantId}`] as never) ?? null;

  const sqs = new SQSClient({ region });
  const queue = new SqsQueue({
    send: async (input) =>
      sqs.send(
        new SendMessageCommand({
          QueueUrl: input.QueueUrl,
          MessageBody: input.MessageBody,
          MessageAttributes: input.MessageAttributes,
        }),
      ).then((r) => ({ MessageId: r.MessageId })),
    queueUrl: (channel) => {
      const base = required("SQS_QUEUE_BASE_URL"); // e.g. https://sqs.ap-south-1.amazonaws.com/123456789012
      return `${base.replace(/\/$/, "")}/${process.env.SQS_QUEUE_PREFIX ?? "factory"}-${channel}`;
    },
  });

  const flags = new FlagCache(async () => {
    // M0: flags ride on env-configured defaults until the DB-backed reader
    // is wired in E0-S4 deployment; the interface matches FlagCache
    // (key → boolean per tenant; unknown keys fall back to the default).
    const out: Record<string, boolean> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (name.startsWith("FLAG_")) out[name.slice(5).toLowerCase()] = value === "true";
    }
    return out;
  }, 30_000);
  void tenantFlagsLookup(flags);

  return createApp({
    auth: { secret: jwtSecret, lookupMembership: lookup },
    queue,
    flags: { isEnabled: (t, k, d) => flags.isEnabled(t, k, d) },
  });
}

async function tenantFlagsLookup(flags: FlagCache): Promise<void> {
  // warm the cache lazily; errors surface on first isEnabled() call.
  try {
    await flags.getAll("_warmup_");
  } catch {
    /* first call may fail before DB is reachable — ignored by design */
  }
}

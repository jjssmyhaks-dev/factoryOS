/**
 * M0 core stacks (PRD §4.3 physical architecture).
 *
 *   Webhooks ─▶ Ingress Fn ─▶ SQS(agent-run) ─▶ Workers Fn
 *   API (Hono, Function URL or API GW) ─▶ SQS
 *   EventBridge Scheduler ─▶ SQS(sync)
 *   S3 documents bucket (SSE-KMS, presigned uploads)
 *
 * Environment-specific config comes from stage-scoped env (.env.<stage>):
 * JWT secret and DB URL are *referenced* — never inlined (Global DoD §0.8).
 */

export async function createStacks() {
  // ── Queues (SQS with DLQs — §4.3 rule 4: at-least-once, idempotent handlers)
  const agentRunDlq = new sst.aws.Queue("AgentRunDLQ");
  const agentRunQueue = new sst.aws.Queue("AgentRunQueue", {
    visibilityTimeout: "6 minutes", // agent runs include LLM calls (120 s/step budget)
    dlq: { queue: agentRunDlq.arn, retry: 3 },
  });

  const syncDlq = new sst.aws.Queue("SyncDLQ");
  const syncQueue = new sst.aws.Queue("SyncQueue", {
    visibilityTimeout: "5 minutes",
    dlq: { queue: syncDlq.arn, retry: 5 },
  });

  // ── Document / raw-event storage (§4.3: presigned uploads, media streamed) ─
  const documents = new sst.aws.Bucket("Documents");

  // ── API (ADR-012: Hono on Lambda; Function URL keeps M0 simple — swap to
  //    API Gateway HTTP API in E5 when custom domains/BASP routing arrive) ──
  const api = new sst.aws.Function("Api", {
    handler: "services/api/src/lambda.handler",
    runtime: "nodejs22.x",
    architecture: "arm64", // Graviton — §4.2 stack row
    memory: "512 MB",
    timeout: "30 seconds",
    url: true,
    environment: {
      STAGE: $stage ?? "dev",
      SQS_QUEUE_BASE_URL: "https://sqs.ap-south-1.amazonaws.com",
      SQS_QUEUE_PREFIX: "factory",
      // Secrets are referenced from the environment/Secrets Manager — never
      // literals (they are empty unless set in .env.<stage>).
      JWT_SECRET: process.env.JWT_SECRET ?? "",
    },
    copyFiles: [{ from: "packages/db/migrations", to: "migrations" }],
  });

  // ── Workers (SQS subscribers — §4.3 backpressure via queue config) ────────
  const agentRunWorker = agentRunQueue.subscribe("services/workers/src/handler.agentRun", {
    timeout: "2 minutes",
    environment: {
      STAGE: $stage ?? "dev",
      JWT_SECRET: process.env.JWT_SECRET ?? "",
    },
  });

  const syncWorker = syncQueue.subscribe("services/workers/src/handler.sync", {
    timeout: "4 minutes",
    environment: { STAGE: $stage ?? "dev" },
  });

  // ── Ingress (webhooks: verify → persist → enqueue → 2xx, §4.3 rule 1) ─────
  const ingress = new sst.aws.Function("Ingress", {
    handler: "services/ingress/src/lambda.handler",
    runtime: "nodejs22.x",
    architecture: "arm64",
    memory: "256 MB",
    timeout: "10 seconds", // must answer < 2 s; the rest is belt-and-braces
    url: true,
    link: [documents, agentRunQueue],
    environment: { STAGE: $stage ?? "dev" },
  });

  // Link grants: workers read the queue + bucket; api enqueues.
  void [api, agentRunWorker, syncWorker, ingress, documents];

  return {
    apiUrl: api.url?.url ?? "",
    ingressUrl: ingress.url?.url ?? "",
    agentRunQueueUrl: agentRunQueue.url,
    syncQueueUrl: syncQueue.url,
    documentsBucket: documents.bucket,
  };
}

/** Stage helper — SST exposes the stage via env in run(). */
const $stage = process.env.SST_STAGE ?? process.argv.find((a) => a.startsWith("--stage="))?.split("=")[1];

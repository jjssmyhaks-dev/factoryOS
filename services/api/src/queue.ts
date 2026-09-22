import { randomUUID } from "node:crypto";
import { toMessageAttributes, type TraceContext } from "@factory/observability";

/**
 * E0-S3: a request that enqueues a job produces ONE trace spanning API →
 * queue → worker. The API's current trace context travels as a `traceparent`
 * SQS message attribute; the worker extracts it and continues the trace.
 *
 * The queue behind this port is SQS in AWS and an in-memory double in tests.
 */

export interface EnqueueRequest {
  /** Queue/channel name, e.g. "agent-run", "sync". */
  channel: string;
  body: Record<string, unknown>;
  /** Correlation ids stamped onto the message for logs. */
  tenant_id: string;
  request_id: string;
  /** Current W3C trace context (undefined → a fresh root is created downstream). */
  trace?: TraceContext | undefined;
  /** Deterministic key: same key → same message id (at-least-once safety). */
  idempotencyKey?: string;
}

export interface EnqueueResult {
  message_id: string;
  idempotency_key: string;
}

export interface JobQueue {
  enqueue(req: EnqueueRequest): Promise<EnqueueResult>;
}

/** In-memory queue for unit tests and local dev. */
export class InMemoryQueue implements JobQueue {
  readonly sent: EnqueueRequest[] = [];

  async enqueue(req: EnqueueRequest): Promise<EnqueueResult> {
    const idempotencyKey =
      req.idempotencyKey ?? `${req.channel}:${req.tenant_id}:${randomUUID()}`;
    this.sent.push({ ...req, idempotencyKey });
    return { message_id: randomUUID(), idempotency_key: idempotencyKey };
  }
}

/** SQS-backed queue (used by the Lambda bootstrap and LocalStack tests). */
export class SqsQueue implements JobQueue {
  constructor(
    private readonly deps: {
      send(input: {
        QueueUrl: string;
        MessageBody: string;
        MessageAttributes?: Record<string, { DataType: string; StringValue: string }>;
        MessageGroupId?: string;
      }): Promise<{ MessageId?: string }>;
      queueUrl(channel: string): string;
    },
  ) {}

  async enqueue(req: EnqueueRequest): Promise<EnqueueResult> {
    const idempotencyKey =
      req.idempotencyKey ?? `${req.channel}:${req.tenant_id}:${randomUUID()}`;
    const message = {
      ...req,
      idempotency_key: idempotencyKey,
      enqueued_at: new Date().toISOString(),
    };
    const attributes = {
      ...(req.trace ? toMessageAttributes(req.trace) : {}),
      tenant_id: { DataType: "String", StringValue: req.tenant_id },
      request_id: { DataType: "String", StringValue: req.request_id },
    };
    const res = await this.deps.send({
      QueueUrl: this.deps.queueUrl(req.channel),
      MessageBody: JSON.stringify(message),
      MessageAttributes: attributes,
    });
    return { message_id: res.MessageId ?? randomUUID(), idempotency_key: idempotencyKey };
  }
}

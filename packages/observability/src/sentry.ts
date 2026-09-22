/**
 * E0-S3: Sentry receives unhandled errors with tenant context. We keep the
 * dependency surface tiny: a reporter interface the services wire to the real
 * @sentry/node SDK at boot (or a no-op / memory sink in tests and dev).
 */

import { redactText } from "./redact.js";
import type { Logger } from "./logger.js";

export interface ErrorReporter {
  captureException(err: Error, context?: Record<string, unknown>): void;
}

export const noopReporter: ErrorReporter = {
  captureException: () => undefined,
};

export function memoryReporter(): ErrorReporter & { errors: Array<{ err: Error; context?: Record<string, unknown> }> } {
  const errors: Array<{ err: Error; context?: Record<string, unknown> }> = [];
  return {
    errors,
    captureException(err, context) {
      errors.push({ err, context });
    },
  };
}

/**
 * Capture an unhandled error: report with tenant context, log a redacted
 * summary. Used by the services' global error hooks.
 */
export function captureUnhandled(
  reporter: ErrorReporter,
  logger: Logger,
  err: unknown,
  context: { tenant_id?: string; request_id?: string; run_id?: string } = {},
): void {
  const error = err instanceof Error ? err : new Error(String(err));
  logger.error(redactText(error.message), {
    ...context,
    stack: error.stack ? redactText(error.stack) : undefined,
  });
  reporter.captureException(error, context);
}

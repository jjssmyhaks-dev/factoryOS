/**
 * Structured JSON logs (Global DoD §0.3): every line carries tenant_id and
 * request_id or run_id when known. Fields are top-level for CloudWatch Logs
 * Insights queries. Redaction (§7.2) is applied to any free-text message.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  tenant_id?: string;
  request_id?: string;
  run_id?: string;
  action_id?: string;
  trace_id?: string;
  [key: string]: unknown;
}

export interface LogRecord extends LogContext {
  level: LogLevel;
  msg: string;
  ts: string;
}

export type LogSink = (record: LogRecord) => void;

const consoleSink: LogSink = (record) => {
  const line = JSON.stringify(record);
  if (record.level === "error") console.error(line);
  else if (record.level === "warn") console.warn(line);
  else console.log(line); // eslint-disable-line no-console -- structured logs are the product
};

export interface Logger {
  child(ctx: LogContext): Logger;
  debug(msg: string, extra?: LogContext): void;
  info(msg: string, extra?: LogContext): void;
  warn(msg: string, extra?: LogContext): void;
  error(msg: string, extra?: LogContext): void;
}

export interface LoggerOptions {
  base?: LogContext;
  sink?: LogSink;
  /** Minimum level; default "info" (config via env in services). */
  level?: LogLevel;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? consoleSink;
  const min = LEVEL_ORDER[options.level ?? "info"];
  const base = options.base ?? {};

  function log(level: LogLevel, msg: string, extra?: LogContext): void {
    if (LEVEL_ORDER[level] < min) return;
    sink({ ...base, ...extra, level, msg, ts: new Date().toISOString() });
  }

  return {
    child(ctx) {
      return createLogger({ ...options, base: { ...base, ...ctx } });
    },
    debug: (msg, extra) => log("debug", msg, extra),
    info: (msg, extra) => log("info", msg, extra),
    warn: (msg, extra) => log("warn", msg, extra),
    error: (msg, extra) => log("error", msg, extra),
  };
}

/** A logger that collects records in memory — for tests. */
export function createMemoryLogger(base?: LogContext): {
  logger: Logger;
  records: LogRecord[];
} {
  const records: LogRecord[] = [];
  const logger = createLogger({ base, sink: (r) => records.push(r), level: "debug" });
  return { logger, records };
}

import { describe, expect, it } from "vitest";
import { createLogger, createMemoryLogger } from "../src/logger.js";
import {
  DEFAULT_REDACTION,
  fingerprint,
  redactText,
  redactValue,
} from "../src/redact.js";
import { currentTraceId, startStepSpan, withStepSpan } from "../src/trace.js";
import {
  formatTraceparent,
  fromMessageAttributes,
  parseTraceparent,
  randomSpanId,
  randomTraceId,
  toMessageAttributes,
} from "../src/propagation.js";
import { captureUnhandled, memoryReporter, noopReporter } from "../src/sentry.js";

describe("logger", () => {
  it("emits JSON records with context fields", () => {
    const { logger, records } = createMemoryLogger({ tenant_id: "t1", request_id: "r1" });
    logger.info("hello", { run_id: "run1" });
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.level).toBe("info");
    expect(rec.msg).toBe("hello");
    expect(rec.tenant_id).toBe("t1");
    expect(rec.request_id).toBe("r1");
    expect(rec.run_id).toBe("run1");
    expect(rec.ts).toBeTruthy();
  });

  it("child loggers inherit and override context", () => {
    const { logger, records } = createMemoryLogger({ tenant_id: "t1" });
    logger.child({ run_id: "run9" }).warn("busy");
    expect(records[0]!.tenant_id).toBe("t1");
    expect(records[0]!.run_id).toBe("run9");
    expect(records[0]!.level).toBe("warn");
  });

  it("filters below the configured level", () => {
    const records: unknown[] = [];
    const logger = createLogger({ level: "warn", sink: (r) => records.push(r) });
    logger.info("skipped");
    logger.error("kept");
    expect(records).toHaveLength(1);
  });
});

describe("redaction", () => {
  it("removes phone numbers and emails by default", () => {
    const out = redactText("call +919876543210 or a.b@corp.com today");
    expect(out).not.toContain("9876543210");
    expect(out).not.toContain("a.b@corp.com");
    expect(out).toContain("##phone##");
    expect(out).toContain("##email##");
  });

  it("hashes GSTIN and PAN so values stay correlatable", () => {
    const gstin = "24AAACN1234A1Z5";
    const out = redactText(`gstin ${gstin} pan AAACN1234A`);
    expect(out).not.toContain(gstin);
    expect(out).toMatch(/##gstin:[0-9a-f]{8}##/);
    expect(out).toMatch(/##pan:[0-9a-f]{8}##/);
    expect(redactText(gstin)).toBe(redactText(gstin));
  });

  it("redacts nested structures and sensitive field names", () => {
    const value = {
      note: "mail me at x@y.z",
      email: "raw@person.in",
      phone: "+919876543210",
      nested: { gstin_value: "24AAACN1234A1Z5", list: ["call 9876543210"] },
    };
    const out = redactValue(value);
    expect(out.email).toBe("##redacted##");
    expect(out.phone).toBe("##redacted##");
    expect(out.note).not.toContain("x@y.z");
    expect(JSON.stringify(out)).not.toContain("9876543210");
    expect(JSON.stringify(out)).not.toContain("24AAACN1234A1Z5");
  });

  it("honours per-key mode overrides", () => {
    const out = redactText("24AAACN1234A1Z5", { gstin: "remove" });
    expect(out).toBe("##gstin##");
    expect(DEFAULT_REDACTION.gstin).toBe("hash");
  });

  it("fingerprint is stable and short", () => {
    expect(fingerprint("abc")).toBe(fingerprint("abc"));
    expect(fingerprint("abc")).not.toBe(fingerprint("abd"));
    expect(fingerprint("abc")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("trace spans", () => {
  it("withStepSpan returns the value when no SDK is registered", async () => {
    const result = await withStepSpan(
      "llm.extract",
      {
        tenant_id: "t1",
        run_id: "r1",
        agent_id: "capture",
        agent_version: "1.0.0",
        step_kind: "llm",
        step_name: "extract",
      },
      async () => 42,
    );
    expect(result).toBe(42);
  });

  it("withStepSpan records exception and rethrows", async () => {
    await expect(
      withStepSpan(
        "tool.fail",
        {
          tenant_id: "t1",
          run_id: "r1",
          agent_id: "capture",
          agent_version: "1.0.0",
          step_kind: "tool",
          step_name: "fail",
        },
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");
  });

  it("startStepSpan returns a usable span", () => {
    const span = startStepSpan("validator.check", {
      tenant_id: "t1",
      run_id: "r1",
      agent_id: "a",
      agent_version: "1",
      step_kind: "validator",
      step_name: "check",
    });
    span.setAttribute("custom", "x");
    span.end();
    expect(currentTraceId()).toBeUndefined();
  });
});

describe("traceparent propagation (E0-S3)", () => {
  it("round-trips through SQS message attributes", () => {
    const ctx = { traceId: randomTraceId(), parentSpanId: randomSpanId(), sampled: true };
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.parentSpanId).toMatch(/^[0-9a-f]{16}$/);
    const attrs = toMessageAttributes(ctx);
    const back = fromMessageAttributes(attrs);
    expect(back).toEqual(ctx);
  });

  it("rejects malformed traceparent values", () => {
    expect(parseTraceparent(undefined)).toBeUndefined();
    expect(parseTraceparent("garbage")).toBeUndefined();
    expect(parseTraceparent("00-" + "0".repeat(32) + "-" + "1".repeat(16) + "-01")).toBeUndefined();
    expect(parseTraceparent("01-abc-def-01")).toBeUndefined();
  });

  it("respects the sampled flag", () => {
    const tp = formatTraceparent({
      traceId: "a".repeat(32),
      parentSpanId: "b".repeat(16),
      sampled: false,
    });
    expect(tp.endsWith("-00")).toBe(true);
    expect(parseTraceparent(tp)?.sampled).toBe(false);
  });
});

describe("sentry hook", () => {
  it("reports with tenant context and redacts the message", () => {
    const reporter = memoryReporter();
    const { logger, records } = createMemoryLogger();
    captureUnhandled(reporter, logger, new Error("failed for +919876543210"), {
      tenant_id: "t1",
      request_id: "r1",
    });
    expect(reporter.errors).toHaveLength(1);
    expect(reporter.errors[0]!.context).toMatchObject({ tenant_id: "t1", request_id: "r1" });
    expect(records[0]!.msg).not.toContain("9876543210");
    expect(records[0]!.level).toBe("error");
  });

  it("noop reporter swallows errors", () => {
    expect(() => noopReporter.captureException(new Error("x"))).not.toThrow();
  });

  it("wraps non-Error values", () => {
    const reporter = memoryReporter();
    const { logger } = createMemoryLogger();
    captureUnhandled(reporter, logger, "string failure");
    expect(reporter.errors[0]!.err).toBeInstanceOf(Error);
  });
});

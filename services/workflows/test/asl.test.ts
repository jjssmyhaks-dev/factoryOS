import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ASL_DIR, generatedAsl, loadAsl } from "../src/index.js";

describe("services/workflows/asl (generated, §6.9)", () => {
  const generated = generatedAsl();

  it("contains exactly the two generated workflows", () => {
    const onDisk = readdirSync(ASL_DIR).filter((f) => f.endsWith(".json")).sort();
    expect(onDisk).toEqual(["action-lifecycle.json", "agent-run.json"].sort());
  });

  for (const [name, definition] of Object.entries(generated)) {
    it(`${name} matches the transition table exactly`, () => {
      const disk = readFileSync(join(ASL_DIR, name), "utf8");
      expect(JSON.parse(disk)).toEqual(definition);
    });
  }

  it("action-lifecycle starts at 'proposed' and waits for approval", () => {
    const asl = loadAsl("action-lifecycle");
    expect(asl.StartAt).toBe("proposed");
    const wait = asl.States["pending_approval"] as Record<string, any>;
    expect(wait.TimeoutSeconds).toBe(86_400);
    expect(wait.Parameters.Payload["taskToken.$"]).toBe("$$.Task.Token");
  });

  it("agent-run starts at 'running' and catches failures", () => {
    const asl = loadAsl("agent-run");
    expect(asl.StartAt).toBe("running");
    expect(asl.States["running"]).toHaveProperty("Catch");
    expect(asl.States["succeeded"]).toMatchObject({ Type: "Succeed" });
    expect(asl.States["failed"]).toMatchObject({ Type: "Fail" });
  });
});

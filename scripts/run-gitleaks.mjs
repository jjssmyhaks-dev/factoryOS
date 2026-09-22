#!/usr/bin/env node
/**
 * Runs gitleaks when available. In CI a missing binary is a failure so the
 * secret scan can never silently skip; locally it warns.
 */
import { spawnSync } from "node:child_process";

const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
const probe = spawnSync("gitleaks", ["version"], { stdio: "ignore" });

if (probe.error || probe.status !== 0) {
  const msg = "gitleaks not installed — install from https://github.com/gitleaks/gitleaks";
  if (isCI) {
    console.error(msg);
    process.exit(1);
  }
  console.warn(`warning: ${msg} (skipping locally)`);
  process.exit(0);
}

const args = ["detect", "-c", ".gitleaks.toml", "--redact", "-v"];
if (process.env.GITLEAKS_FULL_HISTORY === "1") args.push("--log-opts", "--all");
const res = spawnSync("gitleaks", args, { stdio: "inherit" });
process.exit(res.status ?? 1);

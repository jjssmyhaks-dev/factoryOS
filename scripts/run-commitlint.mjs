#!/usr/bin/env node
/**
 * Conventional-commit check. With --from/--to (CI PR mode) it lints the range;
 * locally it lints the latest commit message.
 */
import { spawnSync } from "node:child_process";

const args = [];
const from = process.env.COMMITLINT_FROM;
const to = process.env.COMMITLINT_TO;
if (from && to) {
  args.push("--from", from, "--to", to, "--verbose");
} else {
  const head = spawnSync("git", ["log", "-1", "--format=%B"], { encoding: "utf8" });
  if (head.status !== 0) {
    console.warn("warning: not a git repository, skipping commitlint");
    process.exit(0);
  }
  args.push("--edit");
}

const res = spawnSync("pnpm", ["exec", "commitlint", ...args], { stdio: "inherit" });
process.exit(res.status ?? 1);

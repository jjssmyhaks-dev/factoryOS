/**
 * Watches packages/** for source/test/data changes and re-runs the eval CLI
 * (debounced, single-flight) while the dashboard's watch toggle is on.
 * The watcher handle lives on globalThis to survive Next.js dev HMR.
 */
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { findRepoRoot, getRunnerState, requestRun } from "./eval-runner";

interface WatchCell {
  watcher: FSWatcher | null;
  timer: ReturnType<typeof setTimeout> | null;
}

type WatchGlobal = typeof globalThis & { __factoryEvalWatch?: WatchCell };

const DEBOUNCE_MS = 750;
const INTERESTING = /\.(ts|tsx|js|cjs|mjs|json|sql|md)$/;

export function setWatch(enabled: boolean): void {
  const state = getRunnerState();
  if (state.watch === enabled) return;
  state.watch = enabled;
  if (enabled) startWatch();
  else stopWatch();
}

function cell(): WatchCell {
  const g = globalThis as WatchGlobal;
  if (!g.__factoryEvalWatch) g.__factoryEvalWatch = { watcher: null, timer: null };
  return g.__factoryEvalWatch;
}

function startWatch(): void {
  const c = cell();
  if (c.watcher) return;
  try {
    c.watcher = watch(join(findRepoRoot(), "packages"), { recursive: true }, (_event, filename) => {
      const name = filename ? String(filename) : "";
      if (name.includes("node_modules")) return;
      if (!INTERESTING.test(name)) return;
      schedule(c);
    });
  } catch (err) {
    console.error("eval watch could not start:", err);
  }
}

function schedule(c: WatchCell): void {
  if (c.timer) clearTimeout(c.timer);
  c.timer = setTimeout(() => {
    c.timer = null;
    requestRun();
  }, DEBOUNCE_MS);
}

function stopWatch(): void {
  const c = cell();
  if (c.timer) {
    clearTimeout(c.timer);
    c.timer = null;
  }
  c.watcher?.close();
  c.watcher = null;
}

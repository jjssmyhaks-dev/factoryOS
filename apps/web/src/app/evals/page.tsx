"use client";

import { useCallback, useEffect, useState } from "react";
import type { RunnerState } from "../../lib/eval-runner";

async function fetchState(): Promise<RunnerState> {
  const res = await fetch("/api/eval/run", { cache: "no-store" });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()) as RunnerState;
}

export default function EvalGatePage() {
  const [status, setStatus] = useState<RunnerState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await fetchState());
      setError(null);
    } catch {
      setError("dev server unreachable");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 2000);
    return () => clearInterval(id);
  }, [refresh]);

  const runNow = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/eval/run", { method: "POST" });
      if (res.status !== 200 && res.status !== 202) throw new Error(`status ${res.status}`);
      await refresh();
    } catch {
      setError("run failed to start");
    } finally {
      setBusy(false);
    }
  };

  const toggleWatch = async () => {
    if (!status) return;
    try {
      const res = await fetch("/api/eval/watch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !status.watch }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setStatus((await res.json()) as RunnerState);
      setError(null);
    } catch {
      setError("could not toggle watch");
    }
  };

  const last = status?.lastRun ?? null;
  const running = status?.running ?? false;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Eval gate — demo agent</h1>
          <p className="mt-1 text-sm text-slate-500">
            §7.4 gate over the demo-smoke golden dataset · re-runs the eval CLI
          </p>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={status?.watch ?? false}
              onChange={() => void toggleWatch()}
              className="h-4 w-4 accent-indigo-600"
            />
            Watch test changes
          </label>
          <button
            type="button"
            onClick={() => void runNow()}
            disabled={busy || running}
            className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {running || busy ? "Running…" : "Run eval"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {last ? (
        <>
          <div
            className={`mt-6 rounded-lg border px-4 py-3 text-sm font-semibold ${
              last.gatePassed
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-red-200 bg-red-50 text-red-700"
            }`}
          >
            {last.gatePassed ? "GATE PASSED" : "GATE FAILED"} — accuracy{" "}
            {last.accuracyPct.toFixed(2)}% over {last.n} cases · total cost ₹
            {last.totalCostInr.toFixed(4)}
          </div>

          <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Accuracy" value={`${last.accuracyPct.toFixed(2)}%`} />
            <Stat label="Avg cost / case" value={`₹${last.avgCostInr.toFixed(4)}`} />
            <Stat
              label="Last run duration"
              value={last.durationMs != null ? `${(last.durationMs / 1000).toFixed(1)}s` : "—"}
            />
            <Stat
              label="Generated"
              value={new Date(last.generatedAt).toLocaleTimeString()}
            />
          </div>

          {last.error && (
            <div className="mt-4 whitespace-pre-wrap rounded border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
              last run reported: {last.error}
            </div>
          )}

          {last.failures.length > 0 && (
            <ul className="mt-4 space-y-1 rounded border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
              {last.failures.map((f) => (
                <li key={f.rule}>
                  <strong>{f.rule}</strong> — {f.detail}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-6 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Full report</h2>
            <a
              href="/api/eval/report"
              target="_blank"
              rel="noreferrer"
              className="text-xs font-medium text-indigo-600 hover:text-indigo-500"
            >
              open in new tab ↗
            </a>
          </div>
          <iframe
            key={last.generatedAt}
            src="/api/eval/report"
            title="Eval report"
            className="mt-2 h-[520px] w-full rounded-lg border border-slate-200 bg-white"
          />

          {status && status.history.length > 1 && (
            <div className="mt-6">
              <h2 className="text-sm font-semibold text-slate-900">History</h2>
              <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white text-sm">
                {status.history.map((h) => (
                  <li
                    key={h.generatedAt}
                    className="flex items-center justify-between px-4 py-2"
                  >
                    <span className="text-slate-500">
                      {new Date(h.generatedAt).toLocaleTimeString()}
                    </span>
                    <span className="tabular-nums text-slate-700">
                      {h.accuracyPct.toFixed(2)}%
                    </span>
                    <span
                      className={`text-xs font-semibold ${h.gatePassed ? "text-emerald-600" : "text-red-600"}`}
                    >
                      {h.gatePassed ? "PASS" : "FAIL"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : (
        <div className="mt-10 rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          No eval has run yet — press <strong>Run eval</strong> to execute the golden dataset.
        </div>
      )}

      {running && (
        <p className="mt-3 text-xs text-slate-500">
          Run in progress — the view refreshes automatically when it finishes.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-semibold text-slate-900">{value}</div>
    </div>
  );
}

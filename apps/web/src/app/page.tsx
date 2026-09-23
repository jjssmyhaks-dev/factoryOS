import Link from "next/link";

interface Card {
  label: string;
  value: string;
  note: string;
}

const CARDS: Card[] = [
  { label: "Approvals pending", value: "3", note: "sample data" },
  { label: "Autonomy level", value: "L2 · suggest", note: "tenant default" },
  { label: "Actions this week", value: "12", note: "sample data" },
  { label: "Est. hours saved", value: "6.5", note: "sample data" },
];

const E12 = [
  "Approvals inbox — review AI-proposed actions before they execute",
  "AI Activity ledger — every extraction, decision and proposal with provenance",
  "Autonomy settings — per-action-type levels with quiet hours and spend caps",
  "ROI report — time and cost saved against your configured rates",
  "Connection wizard — WhatsApp, e-invoice and Tally onboarding",
];

export default function OverviewPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-xl font-semibold text-slate-900">Overview</h1>
      <p className="mt-1 text-sm text-slate-500">
        M0 scaffold — the cards below are placeholders until the E12 console lands.
      </p>

      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {CARDS.map((c) => (
          <div key={c.label} className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">{c.label}</div>
            <div className="mt-1 text-2xl font-semibold text-slate-900">{c.value}</div>
            <div className="mt-1 text-[11px] text-slate-400">{c.note}</div>
          </div>
        ))}
      </div>

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Eval gate (§7.4)</h2>
            <Link
              href="/evals"
              className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
            >
              Open live dashboard
            </Link>
          </div>
          <p className="mt-2 text-sm text-slate-600">
            Re-run the golden-dataset eval for the demo agent, watch the gate verdict, and open
            the full HTML report — live from this console.
          </p>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">Landing in E12</h2>
          <ul className="mt-2 space-y-1.5 text-sm text-slate-600">
            {E12.map((item) => (
              <li key={item} className="flex gap-2">
                <span className="text-slate-400">·</span>
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

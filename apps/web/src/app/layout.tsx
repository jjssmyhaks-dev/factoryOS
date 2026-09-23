import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Factory AI OS — Customer Console",
  description: "AI operations layer for Indian MSME manufacturers (INR, GST, WhatsApp-native)",
};

interface NavItem {
  label: string;
  href?: string;
  milestone?: string;
}

const NAV: NavItem[] = [
  { label: "Overview", href: "/" },
  { label: "Eval gate", href: "/evals" },
  { label: "Approvals", milestone: "E12" },
  { label: "AI Activity", milestone: "E12" },
  { label: "Autonomy settings", milestone: "E12" },
  { label: "Connections", milestone: "E12" },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="flex min-h-screen">
          <aside className="w-56 shrink-0 border-r border-slate-200 bg-white px-4 py-6">
            <div className="mb-6">
              <div className="text-sm font-semibold tracking-tight text-slate-900">
                Factory AI OS
              </div>
              <div className="text-xs text-slate-500">Customer console</div>
            </div>
            <nav className="flex flex-col gap-1">
              {NAV.map((item) =>
                item.href ? (
                  <Link
                    key={item.label}
                    href={item.href}
                    className="rounded px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
                  >
                    {item.label}
                  </Link>
                ) : (
                  <span
                    key={item.label}
                    title={`Lands in milestone ${item.milestone ?? "E12"}`}
                    className="flex items-center justify-between rounded px-2 py-1.5 text-sm text-slate-400"
                  >
                    {item.label}
                    <span className="rounded bg-slate-100 px-1 py-0.5 text-[10px] font-medium text-slate-500">
                      {item.milestone}
                    </span>
                  </span>
                ),
              )}
            </nav>
          </aside>
          <main className="flex-1 px-8 py-8">{children}</main>
        </div>
      </body>
    </html>
  );
}

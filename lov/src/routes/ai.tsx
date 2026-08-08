import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowUp, Check, Pin, Sparkles, Table2, PieChart as PieIcon, TrendingUp } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Panel } from "@/components/finance/primitives";
import { compact, spendingByCategory, transactions } from "@/lib/finance-data";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/ai")({
  head: () => ({
    meta: [
      { title: "AI Workspace · Lumen finance" },
      {
        name: "description",
        content:
          "Chat with your money, generate custom interactive views from your data, and pin them to your dashboard.",
      },
      { property: "og:title", content: "AI Workspace · Lumen finance" },
      {
        property: "og:description",
        content: "Generate custom interactive views from your financial data and pin them.",
      },
    ],
  }),
  component: Workspace,
});

type Msg = { role: "user" | "ai"; text: string };

const seed: Msg[] = [
  { role: "user", text: "Where did my money actually go last month?" },
  {
    role: "ai",
    text: "Housing took 49% of your outflow, but the real change is Dining — €312 across 21 visits, up 18% on your six-month average. I built an interactive breakdown on the right.",
  },
];

const prompts = [
  "Can I afford a €2,400 trip in October?",
  "Show my dining spend by weekday",
  "Which merchants raised prices this year?",
  "Forecast my savings to December",
];

function Bubble({ m }: { m: Msg }) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[82%] rounded-[20px] rounded-br-md bg-primary px-4 py-3 text-sm font-medium text-primary-foreground">
          {m.text}
        </p>
      </div>
    );
  }
  return (
    <div className="flex gap-3">
      <span
        className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-xl text-primary-foreground"
        style={{ background: "var(--gradient-ai)" }}
      >
        <Sparkles className="h-3.5 w-3.5" />
      </span>
      <p className="max-w-[86%] text-sm leading-relaxed text-foreground">{m.text}</p>
    </div>
  );
}

function Workspace() {
  const [messages, setMessages] = useState<Msg[]>(seed);
  const [input, setInput] = useState("");
  const [pinned, setPinned] = useState(false);
  const [tab, setTab] = useState<"chart" | "table">("chart");
  const max = Math.max(...spendingByCategory.map((c) => c.value));

  const send = (text: string) => {
    if (!text.trim()) return;
    setMessages((m) => [
      ...m,
      { role: "user", text },
      {
        role: "ai",
        text: "Rebuilt the view on the right using 412 transactions across 4 accounts. Pin it if you'd like it on your dashboard.",
      },
    ]);
    setInput("");
  };

  return (
    <AppShell
      title="AI Workspace"
      subtitle="Ask anything. Get a view. Pin what matters."
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        <Panel className="flex h-[640px] flex-col" padded={false}>
          <div className="flex-1 space-y-6 overflow-y-auto p-6">
            {messages.map((m, i) => (
              <Bubble key={i} m={m} />
            ))}
          </div>

          <div className="border-t border-border/70 p-4">
            <div className="mb-3 flex flex-wrap gap-2">
              {prompts.map((p) => (
                <button
                  key={p}
                  onClick={() => send(p)}
                  className="rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                >
                  {p}
                </button>
              ))}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
              }}
              className="flex items-center gap-2 rounded-[20px] border border-border bg-muted/50 p-2 pl-4 focus-within:border-primary/40"
            >
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask about your money…"
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
              <button
                type="submit"
                className="grid h-9 w-9 place-items-center rounded-full text-primary-foreground transition-opacity hover:opacity-90"
                style={{ background: "var(--gradient-ai)" }}
                aria-label="Send"
              >
                <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
              </button>
            </form>
          </div>
        </Panel>

        <Panel className="flex h-[640px] flex-col" padded={false}>
          <div className="flex items-start justify-between gap-4 border-b border-border/70 p-5">
            <div>
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                <Sparkles className="h-3 w-3" /> Generated view
              </p>
              <h2 className="mt-1 text-[17px] font-bold">Outflow breakdown · August</h2>
            </div>
            <button
              onClick={() => setPinned((p) => !p)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-semibold transition-colors",
                pinned
                  ? "bg-accent text-accent-foreground"
                  : "border border-border bg-card text-foreground hover:bg-muted",
              )}
            >
              {pinned ? <Check className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
              {pinned ? "Pinned" : "Pin to dashboard"}
            </button>
          </div>

          <div className="flex gap-1 border-b border-border/70 px-5 py-3">
            {(
              [
                { id: "chart", label: "Chart", icon: PieIcon },
                { id: "table", label: "Transactions", icon: Table2 },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors",
                  tab === t.id
                    ? "bg-secondary text-secondary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <t.icon className="h-3.5 w-3.5" />
                {t.label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-6">
            {tab === "chart" ? (
              <div className="space-y-4">
                {spendingByCategory.map((c) => (
                  <div key={c.name}>
                    <div className="mb-1.5 flex items-baseline justify-between text-sm">
                      <span className="font-medium">{c.name}</span>
                      <span className="tnum font-semibold">{compact(c.value)}</span>
                    </div>
                    <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${(c.value / max) * 100}%`, backgroundColor: c.color }}
                      />
                    </div>
                  </div>
                ))}
                <div className="mt-6 flex items-start gap-3 rounded-2xl bg-muted/60 p-4">
                  <TrendingUp className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    Dining is your fastest growing category. Capping it at{" "}
                    <span className="font-semibold text-foreground">€260</span> keeps your savings
                    rate at 24%.
                  </p>
                </div>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="pb-3 font-semibold">Merchant</th>
                    <th className="pb-3 font-semibold">Category</th>
                    <th className="pb-3 text-right font-semibold">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {transactions.map((t) => (
                    <tr key={t.id}>
                      <td className="py-3 font-medium">{t.merchant}</td>
                      <td className="py-3 text-muted-foreground">{t.category}</td>
                      <td className="tnum py-3 text-right font-semibold">
                        {compact(Math.abs(t.amount))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Panel>
      </div>
    </AppShell>
  );
}
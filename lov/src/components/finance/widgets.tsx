import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowUpRight, Sparkles } from "lucide-react";
import {
  accounts,
  budgets,
  compact,
  holdings,
  money,
  netWorthSeries,
  recurring,
  spendingByCategory,
  transactions,
} from "@/lib/finance-data";
import { Panel, PanelHead, Delta } from "./primitives";
import { cn } from "@/lib/utils";

const tooltipStyle = {
  borderRadius: 14,
  border: "1px solid var(--border)",
  background: "var(--card)",
  boxShadow: "var(--shadow-float)",
  fontSize: 12,
  padding: "8px 12px",
} as const;

export function NetWorthPanel() {
  return (
    <Panel className="overflow-hidden" padded={false}>
      <div className="p-6" style={{ background: "var(--gradient-hero)" }}>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Net worth
        </p>
        <div className="mt-2 flex flex-wrap items-end gap-3">
          <p className="tnum text-[40px] font-extrabold leading-none">€83,967.10</p>
          <Delta value={5.7} />
          <span className="pb-1 text-xs text-muted-foreground">vs. last month</span>
        </div>
      </div>
      <div className="h-[190px] w-full px-2 pb-4 pt-6">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={netWorthSeries} margin={{ left: 8, right: 8 }}>
            <defs>
              <linearGradient id="nw" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.35} />
                <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="month"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              dy={6}
            />
            <YAxis hide domain={["dataMin - 8000", "dataMax + 2000"]} />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(v: number) => [compact(v), "Net worth"]}
              cursor={{ stroke: "var(--border)" }}
            />
            <Area
              isAnimationActive={false}
              type="monotone"
              dataKey="value"
              stroke="var(--chart-1)"
              strokeWidth={2.5}
              fill="url(#nw)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}

export function AccountsPanel() {
  return (
    <Panel>
      <PanelHead
        title="Accounts"
        hint="4 connected"
        action={
          <button className="text-xs font-semibold text-primary hover:underline">Manage</button>
        }
      />
      <ul className="space-y-1">
        {accounts.map((a) => (
          <li
            key={a.id}
            className="-mx-2 flex items-center gap-3 rounded-2xl px-2 py-2.5 transition-colors hover:bg-muted/60"
          >
            <span
              className="grid h-9 w-9 place-items-center rounded-xl text-[11px] font-bold text-card"
              style={{ backgroundColor: a.tone }}
            >
              {a.institution.slice(0, 2).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{a.name}</p>
              <p className="text-xs text-muted-foreground">
                {a.institution} · {a.type}
              </p>
            </div>
            <div className="text-right">
              <p className="tnum text-sm font-semibold">{money(a.balance)}</p>
              <p
                className={cn(
                  "tnum text-xs",
                  a.change >= 0 ? "text-positive" : "text-negative",
                )}
              >
                {a.change >= 0 ? "+" : ""}
                {a.change}%
              </p>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function SpendingPanel() {
  const total = spendingByCategory.reduce((s, c) => s + c.value, 0);
  return (
    <Panel>
      <PanelHead title="Spending" hint="August, by category" />
      <div className="flex items-center gap-6">
        <div className="relative h-[132px] w-[132px] shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                isAnimationActive={false}
                data={spendingByCategory}
                dataKey="value"
                innerRadius={46}
                outerRadius={64}
                paddingAngle={3}
                stroke="none"
              >
                {spendingByCategory.map((c) => (
                  <Cell key={c.name} fill={c.color} />
                ))}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => compact(v)} />
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="text-center">
              <p className="tnum text-lg font-bold leading-none">{compact(total)}</p>
              <p className="text-[10px] text-muted-foreground">this month</p>
            </div>
          </div>
        </div>
        <ul className="flex-1 space-y-2">
          {spendingByCategory.map((c) => (
            <li key={c.name} className="flex items-center gap-2 text-sm">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: c.color }}
                aria-hidden
              />
              <span className="flex-1 text-muted-foreground">{c.name}</span>
              <span className="tnum font-semibold">{compact(c.value)}</span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

export function BudgetsPanel() {
  return (
    <Panel>
      <PanelHead title="Budgets" hint="August progress" />
      <ul className="space-y-4">
        {budgets.map((b) => {
          const pct = Math.min((b.spent / b.limit) * 100, 100);
          const over = b.spent > b.limit;
          return (
            <li key={b.name}>
              <div className="mb-1.5 flex items-baseline justify-between text-sm">
                <span className="font-medium">{b.name}</span>
                <span className="tnum text-xs text-muted-foreground">
                  <span className={cn("font-semibold", over ? "text-negative" : "text-foreground")}>
                    {compact(b.spent)}
                  </span>{" "}
                  / {compact(b.limit)}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${pct}%`,
                    backgroundColor: over ? "var(--negative)" : "var(--chart-1)",
                  }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

export function TransactionsPanel({ limit = 6 }: { limit?: number }) {
  return (
    <Panel>
      <PanelHead
        title="Transactions"
        hint="Auto-categorised"
        action={
          <button className="text-xs font-semibold text-primary hover:underline">See all</button>
        }
      />
      <ul className="divide-y divide-border/60">
        {transactions.slice(0, limit).map((t) => (
          <li key={t.id} className="flex items-center gap-3 py-3 first:pt-0">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-muted text-xs font-bold text-muted-foreground">
              {t.merchant.slice(0, 2).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{t.merchant}</p>
              <p className="text-xs text-muted-foreground">
                {t.category} · {t.account}
              </p>
            </div>
            <div className="text-right">
              <p
                className={cn(
                  "tnum text-sm font-semibold",
                  t.amount > 0 ? "text-positive" : "text-foreground",
                )}
              >
                {t.amount > 0 ? "+" : ""}
                {money(t.amount)}
              </p>
              <p className="text-xs text-muted-foreground">{t.date}</p>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function RecurringPanel() {
  const total = recurring.reduce((s, r) => s + r.amount, 0);
  return (
    <Panel>
      <PanelHead title="Recurring" hint={`${compact(total)} committed each month`} />
      <ul className="space-y-1">
        {recurring.map((r) => (
          <li
            key={r.id}
            className="-mx-2 flex items-center gap-3 rounded-2xl px-2 py-2.5 transition-colors hover:bg-muted/60"
          >
            <span className="h-8 w-1 rounded-full bg-accent" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{r.name}</p>
              <p className="text-xs text-muted-foreground">{r.cadence}</p>
            </div>
            <div className="text-right">
              <p className="tnum text-sm font-semibold">{money(r.amount)}</p>
              <p className="text-xs text-muted-foreground">{r.next}</p>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function InvestmentsPanel() {
  return (
    <Panel>
      <PanelHead
        title="Investments"
        hint="Portfolio €62,190.83"
        action={<Delta value={4.7} />}
      />
      <div className="h-[120px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={holdings} margin={{ left: 0, right: 0 }}>
            <XAxis
              dataKey="name"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              dy={4}
            />
            <Tooltip
              cursor={{ fill: "var(--muted)" }}
              contentStyle={tooltipStyle}
              formatter={(v: number) => compact(v)}
            />
            <Bar dataKey="value" isAnimationActive={false} radius={[8, 8, 8, 8]} maxBarSize={34} fill="var(--chart-1)" />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ul className="mt-4 space-y-2">
        {holdings.map((h) => (
          <li key={h.name} className="flex items-center gap-3 text-sm">
            <span className="w-14 font-semibold">{h.name}</span>
            <span className="flex-1 truncate text-muted-foreground">{h.label}</span>
            <span className="tnum font-semibold">{compact(h.value)}</span>
            <span
              className={cn(
                "tnum w-14 text-right text-xs font-semibold",
                h.change >= 0 ? "text-positive" : "text-negative",
              )}
            >
              {h.change >= 0 ? "+" : ""}
              {h.change}%
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function InsightCard() {
  return (
    <div
      className="rounded-[22px] p-6 text-primary-foreground shadow-float"
      style={{ background: "var(--gradient-ai)" }}
    >
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] opacity-80">
        <Sparkles className="h-4 w-4" strokeWidth={2} />
        AI insight
      </div>
      <p className="mt-3 text-[15px] font-semibold leading-relaxed">
        Dining is trending 18% above your usual pace, but two subscriptions went unused in July.
        Cancelling them covers the gap.
      </p>
      <button className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-card/15 px-4 py-2 text-xs font-semibold backdrop-blur transition-colors hover:bg-card/25">
        Open in AI workspace
        <ArrowUpRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
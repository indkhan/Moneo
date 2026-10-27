"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { MouseEvent, ReactNode } from "react";
import { formatMoney } from "@/lib/finance/format";
import { TrendChart } from "./home-trend-chart";

type Flow = "in" | "out";
type Group = { id: string | null; incomeMinor: bigint; spendingMinor: bigint };
type Changes = Record<string, string | undefined>;
export type CashFlowMonth = { month: string; from: string; to: string; label: string; name: string; incomeMinor: bigint; spendingMinor: bigint;
  categories: Group[]; merchants: Group[]; incomeCategories: Group[]; incomeMerchants: Group[] };

const flowOf = (value: string | null): Flow | undefined => value === "in" || value === "out" ? value : undefined;
const flowHref = (search: URLSearchParams, changes: Changes) => {
  const next = new URLSearchParams(search);
  for (const [key, value] of Object.entries(changes)) if (value) next.set(key, value); else next.delete(key);
  return `?${next}#cash-flow`;
};

/**
 * Changes the cash-flow selection in the URL without a server round trip: Home already holds
 * every month's breakdown, and Next syncs native history updates with useSearchParams.
 */
export function CashFlowLink({ changes, className, children, ...props }: { changes: Changes; className?: string; children: ReactNode; "aria-pressed"?: boolean }) {
  const search = useSearchParams();
  const href = flowHref(search, changes);
  const select = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.history.pushState(null, "", href);
    document.getElementById("cash-flow")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  return <a href={href} onClick={select} className={className} {...props}>{children}</a>;
}

function TopList({ title, groups, metric, names, param, from, to, currency, locale, unknown }: {
  title: string; groups: Group[]; metric: "incomeMinor" | "spendingMinor"; names: Record<string, string>; param: "category" | "merchant"; from: string; to: string; currency: string; locale: string; unknown: string;
}) {
  const max = groups[0]?.[metric] ?? 0n;
  return <div className="min-w-0">
    <h3 className="text-sm font-semibold">{title}</h3>
    {groups.length ? <ul className="mt-2 space-y-1">{groups.map(group => <li key={group.id ?? "none"}>
      <Link href={`/money/transactions?${new URLSearchParams({ [param]: group.id ?? "none", from, to, direction: metric === "incomeMinor" ? "income" : "outflow" })}`} className="group block rounded-md px-2 py-1.5 hover:bg-muted">
        <span className="flex justify-between gap-3 text-sm"><span className="truncate group-hover:underline">{group.id ? names[group.id] ?? unknown : unknown}</span><span className="shrink-0 font-mono">{formatMoney(group[metric], currency, locale)}</span></span>
        <span aria-hidden="true" className="mt-1 block h-1 rounded-full bg-muted"><span className={`block h-1 rounded-full ${metric === "incomeMinor" ? "bg-brand" : "bg-chart-out"}`} style={{ width: `${max > 0n ? Number(group[metric] * 100n / max) : 0}%` }} /></span>
      </Link>
    </li>)}</ul> : <p className="mt-2 text-sm text-muted-foreground">Nothing reviewed yet.</p>}
  </div>;
}

/** Six months of money in vs out. Picking In or Out shows only that side and where it came from or went. */
export function CashFlowView({ months, scale, categoryNames, merchantNames, currency, locale, ask }: {
  months: CashFlowMonth[]; scale: number; categoryNames: Record<string, string>; merchantNames: Record<string, string>; currency: string; locale: string; ask: ReactNode;
}) {
  const search = useSearchParams();
  // `show` is which bars are drawn and changes only from these buttons; `flow` is which breakdown is open below.
  const show = flowOf(search.get("show")), flow = flowOf(search.get("flow"));
  const selected = months.find(row => row.month === search.get("month")) ?? months[months.length - 1];
  const when = `in ${selected.name}`;
  const lists = { currency, locale, from: selected.from, to: selected.to };
  return <>
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-medium">Cash flow · 6 months</h2>
      <span className="flex items-center gap-2"><span role="group" aria-label="Show" className="inline-flex rounded-lg border border-border p-0.5">
        {([[undefined, "Both", null], ["in", "In", "bg-brand"], ["out", "Out", "bg-chart-out"]] as const).map(([key, label, swatch]) =>
          <CashFlowLink key={label} changes={{ show: key, flow: key ?? flow }} aria-pressed={show === key}
            className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs ${show === key ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            {swatch && <span aria-hidden="true" className={`size-2 rounded-sm ${swatch}`} />}{label}</CashFlowLink>)}
      </span>{ask}</span></div>
    <div className="mt-4"><TrendChart height={240} flow={show} selected={flow ? months.indexOf(selected) : undefined} picked={flow} months={months.map(row => row.month)} labels={months.map(row => row.label)}
      income={months.map(row => Number(row.incomeMinor) / scale)} spending={months.map(row => Number(row.spendingMinor) / scale)} /></div>
    {flow === "in" && <div className="mt-5 grid gap-6 border-t border-border pt-5 md:grid-cols-2">
      <TopList title={`Where money came from ${when}`} groups={selected.incomeMerchants} metric="incomeMinor" names={merchantNames} param="merchant" unknown="Unknown source" {...lists} />
      <TopList title={`Income by category ${when}`} groups={selected.incomeCategories} metric="incomeMinor" names={categoryNames} param="category" unknown="Uncategorized" {...lists} />
    </div>}
    {flow === "out" && <div className="mt-5 grid gap-6 border-t border-border pt-5 md:grid-cols-2">
      <TopList title={`Top categories ${when}`} groups={selected.categories} metric="spendingMinor" names={categoryNames} param="category" unknown="Uncategorized" {...lists} />
      <TopList title={`Top merchants ${when}`} groups={selected.merchants} metric="spendingMinor" names={merchantNames} param="merchant" unknown="Unknown merchant" {...lists} />
    </div>}
  </>;
}

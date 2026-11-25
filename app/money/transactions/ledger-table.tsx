"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatMoney } from "@/lib/finance/format";
import type { TransactionGroup, TransactionSort } from "./filters";
import { groupKey } from "./grouping";
import { kindLabel, statusLabel } from "./labels";

const BulkBar = dynamic(() => import("./bulk-bar").then(module => module.BulkBar), {
  loading: () => <div aria-busy="true" className="h-16 animate-pulse rounded-xl bg-muted" />,
});

export type LedgerRow = {
  id: string; version: number; posted_on: string; description: string; amount_minor: string; currency_code: string; status: string; kind: string;
  account_id: string; category_id: string | null; merchant_id: string | null; tags: string[] | null; event_name: string | null; review_reasons: string[] | null;
};
type Named = { id: string; name: string };
type LedgerGroups = { by: TransactionGroup; labels: Record<string, string>; summaries: Record<string, { count: number; totals: Record<string, string> }> };

function signed(minor: string, currency: string, locale: string) {
  const value = BigInt(minor);
  return `${value < 0n ? "−" : "+"}${formatMoney(value < 0n ? -value : value, currency, locale)}`;
}
const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

const headingCell = "whitespace-nowrap border-b border-border px-3 py-3.5 font-normal";
const bodyCell = "whitespace-nowrap border-b border-border px-3 py-3.5 md:max-w-xs";

export function LedgerTable({ rows, accountNames, categories, merchants, query, sort, sortHrefs, groups, openId, closeHref, locale, requestId }: {
  rows: LedgerRow[]; accountNames: Record<string, string>; categories: Named[]; merchants: Named[]; query: string; sort: TransactionSort;
  sortHrefs: { date: string; amount: string }; groups: LedgerGroups | null; openId: string | null; closeHref: string; locale: string; requestId: string;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [active, setActive] = useState(() => Math.max(0, rows.findIndex(row => row.id === openId)));
  const body = useRef<HTMLTableSectionElement>(null);
  const href = (id: string) => `/money/transactions?${query}${query ? "&" : ""}transaction=${id}`;
  const categoryNames = useMemo(() => Object.fromEntries(categories.map(row => [row.id, row.name])), [categories]);
  const merchantNames = useMemo(() => Object.fromEntries(merchants.map(row => [row.id, row.name])), [merchants]);
  const toggle = (id: string) => setSelected(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  const allSelected = rows.length > 0 && selected.length === rows.length;
  const arrow = (column: "date" | "amount") => sort.startsWith(column) ? (sort.endsWith("desc") ? "↓" : "↑") : "↕";
  const sortName = { "date-desc": "newest first", "date-asc": "oldest first", "amount-desc": "largest first", "amount-asc": "smallest first" }[sort];

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape" && openId) { router.push(closeHref, { scroll: false }); return; }
      if (typing(event.target) || !rows.length) return;
      if (event.key === "Enter" && event.target instanceof Element && event.target.closest("a, button, summary, input")) return;
      const move = (index: number) => { event.preventDefault(); const next = Math.min(rows.length - 1, Math.max(0, index)); setActive(next); if (openId) router.push(href(rows[next].id), { scroll: false }); };
      if (event.key === "j" || event.key === "ArrowDown") move(active + 1);
      else if (event.key === "k" || event.key === "ArrowUp") move(active - 1);
      else if (event.key === "Enter" || event.key === "o") { event.preventDefault(); router.push(href(rows[active].id), { scroll: false }); }
      else if (event.key === "x") { event.preventDefault(); toggle(rows[active].id); }
      else if (event.key === "/") { event.preventDefault(); document.getElementById("ledger-search")?.focus(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  useEffect(() => { body.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active]);
  const wasOpen = useRef(openId);
  useEffect(() => {
    const closed = wasOpen.current && !openId ? wasOpen.current : null;
    wasOpen.current = openId;
    if (closed) body.current?.querySelector<HTMLElement>(`a[href*="transaction=${closed}"]`)?.focus();
  }, [openId]);

  if (!rows.length) return <p className="rounded-xl border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">No transactions match. Remove a filter or import a statement.</p>;
  const targets = rows.filter(row => selected.includes(row.id));
  return <>
    <div className="overflow-auto rounded-[18px] border border-border bg-card md:[max-height:calc(100dvh-12rem)]">
      <table className="w-full border-separate md:min-w-[720px] border-spacing-0 text-left text-sm">
        <thead className="sticky top-0 z-10 bg-card font-mono text-[11px] uppercase tracking-[0.06em] text-subtle">
          <tr>
            <th scope="col" className={`${headingCell} w-8`}><input type="checkbox" aria-label="Select all on this page" checked={allSelected} onChange={() => setSelected(allSelected ? [] : rows.map(row => row.id))} /></th>
            <th scope="col" className={`${headingCell} max-md:hidden`}><Link className="hover:text-brand" aria-label={`Sort by date (currently ${sortName})`} href={sortHrefs.date} scroll={false}>Date {arrow("date")}</Link></th>
            <th scope="col" className={headingCell}>Description</th>
            <th scope="col" className={`${headingCell} max-md:hidden`}>Category</th>
            <th scope="col" className={`${headingCell} max-md:hidden`}>Merchant</th>
            <th scope="col" className={`${headingCell} max-md:hidden`}>Account</th>
            <th scope="col" className={`${headingCell} text-right`}><Link className="hover:text-brand" aria-label={`Sort by amount (currently ${sortName})`} href={sortHrefs.amount} scroll={false}>Amount {arrow("amount")}</Link></th>
          </tr>
        </thead>
        <tbody ref={body}>
          {rows.map((row, index) => {
            const key = groups ? groupKey(row, groups.by) : null;
            const header = groups && key !== null && (index === 0 || groupKey(rows[index - 1], groups.by) !== key);
            const summary = key ? groups?.summaries[key] : undefined;
            return <Fragment key={row.id}>
              {header && <tr><th colSpan={7} scope="rowgroup" className="border-b border-border bg-card px-3 pb-1.5 pt-4 text-left">
                <span className="text-sm font-medium">{groups.labels[key] ?? key}</span>
                {summary && <span className="ml-3 text-xs font-normal text-muted-foreground">{summary.count} {summary.count === 1 ? "transaction" : "transactions"} · <span className="font-mono">{Object.entries(summary.totals).map(([currency, minor]) => signed(minor, currency, locale)).join(" · ")}</span></span>}
              </th></tr>}
              <tr data-index={index} data-active={index === active || undefined} onClick={() => setActive(index)}
                className={`${index === active ? "bg-muted" : "hover:bg-muted/60"} ${row.id === openId ? "outline outline-1 -outline-offset-1 outline-brand" : ""}`}>
                <td className={bodyCell}><input type="checkbox" aria-label={`Select ${row.description}`} checked={selected.includes(row.id)} onChange={() => toggle(row.id)} /></td>
                <td className={`${bodyCell} max-md:hidden font-mono text-muted-foreground`}>{row.posted_on}</td>
                <td className={`${bodyCell} max-md:w-full max-md:max-w-0`}><span className="flex min-w-0 flex-wrap items-center gap-x-2 md:flex-nowrap">
                  <Link title={row.description ?? undefined} className="min-w-0 max-w-full truncate font-medium text-foreground hover:text-brand hover:underline max-md:line-clamp-2 max-md:whitespace-normal max-md:break-words" href={href(row.id)} scroll={false}>{row.description}</Link>
                  <span className="w-full font-mono text-xs text-muted-foreground md:hidden">{row.posted_on}</span>
                  {row.kind !== "ordinary" || row.status !== "posted" ? <span className="shrink-0 text-[11px] text-muted-foreground">{[row.kind !== "ordinary" && kindLabel(row.kind), row.status !== "posted" && statusLabel(row.status)].filter(Boolean).join(" · ")}</span> : null}
                  {row.review_reasons?.length ? <span title="Needs review" className="shrink-0 rounded-[5px] border border-warning px-1.5 font-mono text-[11px] text-warning">review</span> : null}
                  {row.tags?.map(tag => <span key={tag} className="hidden shrink-0 rounded bg-muted px-1.5 text-[11px] text-muted-foreground lg:inline">{tag}</span>)}
                </span></td>
                <td className={`${bodyCell} max-md:hidden text-muted-foreground`}>{row.category_id ? categoryNames[row.category_id] ?? "Unknown" : "Uncategorized"}</td>
                <td className={`${bodyCell} max-md:hidden text-muted-foreground`}>{row.merchant_id ? merchantNames[row.merchant_id] ?? "Unknown" : "—"}</td>
                <td className={`${bodyCell} max-md:hidden text-muted-foreground`}>{accountNames[row.account_id] ?? "Unknown"}</td>
                <td className={`${bodyCell} text-right font-mono font-medium tabular-nums ${BigInt(row.amount_minor) > 0n ? "text-success" : ""}`}>{signed(row.amount_minor, row.currency_code, locale)}</td>
              </tr>
            </Fragment>;
          })}
        </tbody>
      </table>
    </div>
    {targets.length > 0 && <BulkBar targets={targets} categories={categories} merchants={merchants} query={query} requestId={requestId} locale={locale} onClear={() => setSelected([])} />}
  </>;
}

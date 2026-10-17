"use client";

import Link from "next/link";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { coreFeatures, createCoreRowModel, flexRender, tableFeatures, useTable, type ColumnDef, type CoreFeatures } from "@tanstack/react-table";
import { formatMoney } from "@/lib/finance/format";
import type { TransactionGroup, TransactionSort } from "./filters";
import { groupKey } from "./grouping";
import { kindLabel, statusLabel } from "./labels";
import { BulkBar } from "./bulk-bar";

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

/**
 * Dense ledger table. Sorting and pagination are server-side (keyset, in the
 * URL); this component adds selection, grouping headers and keyboard
 * navigation: j/k move, Enter/o open, x select, / search, Esc close.
 */
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

  const columns = useMemo<ColumnDef<CoreFeatures, LedgerRow>[]>(() => [
    { id: "select", header: () => <input type="checkbox" aria-label="Select all on this page" checked={allSelected} onChange={() => setSelected(allSelected ? [] : rows.map(row => row.id))} />,
      cell: ({ row }) => <input type="checkbox" aria-label={`Select ${row.original.description}`} checked={selected.includes(row.original.id)} onChange={() => toggle(row.original.id)} /> },
    { id: "date", header: () => <Link className="hover:text-brand" aria-label={`Sort by date (currently ${sortName})`} href={sortHrefs.date} scroll={false}>Date {arrow("date")}</Link>,
      cell: ({ row }) => <span className="font-mono text-muted-foreground">{row.original.posted_on}</span> },
    { id: "description", header: "Description", cell: ({ row }) => <span className="flex min-w-0 items-center gap-2">
      <Link className="truncate font-medium text-foreground hover:text-brand hover:underline" href={href(row.original.id)} scroll={false}>{row.original.description}</Link>
      {row.original.review_reasons?.length ? <span title="Needs review" className="shrink-0 rounded bg-amber-100 px-1.5 text-[11px] text-amber-800 dark:bg-amber-950 dark:text-amber-200">Review</span> : null}
      {row.original.tags?.map(tag => <span key={tag} className="hidden shrink-0 rounded bg-muted px-1.5 text-[11px] text-muted-foreground lg:inline">{tag}</span>)}
    </span> },
    { id: "category", header: "Category", cell: ({ row }) => <span className="text-muted-foreground">{row.original.category_id ? categoryNames[row.original.category_id] ?? "Unknown" : "Uncategorized"}</span> },
    { id: "merchant", header: "Merchant", cell: ({ row }) => <span className="text-muted-foreground">{row.original.merchant_id ? merchantNames[row.original.merchant_id] ?? "Unknown" : "—"}</span> },
    { id: "account", header: "Account", cell: ({ row }) => <span className="text-muted-foreground">{accountNames[row.original.account_id] ?? "Unknown"}</span> },
    { id: "type", header: "Type", cell: ({ row }) => <span className="whitespace-nowrap text-xs text-muted-foreground">{kindLabel(row.original.kind)}{row.original.status === "posted" ? "" : ` · ${statusLabel(row.original.status)}`}</span> },
    { id: "amount", header: () => <Link className="hover:text-brand" aria-label={`Sort by amount (currently ${sortName})`} href={sortHrefs.amount} scroll={false}>Amount {arrow("amount")}</Link>,
      cell: ({ row }) => <span className={`font-mono font-medium tabular-nums ${BigInt(row.original.amount_minor) > 0n ? "text-emerald-700 dark:text-emerald-400" : ""}`}>{signed(row.original.amount_minor, row.original.currency_code, locale)}</span> },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [rows, selected, allSelected, sort, sortHrefs, categoryNames, merchantNames, accountNames, locale, query]);

  const table = useTable({ features: tableFeatures({ ...coreFeatures, coreRowModel: createCoreRowModel() }), data: rows, columns, getRowId: row => row.id });

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape" && openId) { router.push(closeHref, { scroll: false }); return; }
      if (typing(event.target) || !rows.length) return;
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

  if (!rows.length) return <p className="rounded-xl border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">No transactions match. Remove a filter or import a statement.</p>;
  const tableRows = table.getRowModel().rows;
  const targets = rows.filter(row => selected.includes(row.id));
  return <>
    <div className="overflow-auto rounded-xl border border-border bg-card [max-height:calc(100dvh-12rem)]">
      <table className="w-full min-w-[860px] border-separate border-spacing-0 text-left text-sm">
        <thead className="sticky top-0 z-10 bg-muted text-xs text-muted-foreground">
          {table.getHeaderGroups().map(group => <tr key={group.id}>{group.headers.map(header =>
            <th key={header.id} scope="col" className={`border-b border-border px-3 py-2 font-medium ${header.column.id === "amount" ? "text-right" : ""} ${header.column.id === "select" ? "w-8" : ""}`}>{flexRender(header.column.columnDef.header, header.getContext())}</th>)}</tr>)}
        </thead>
        <tbody ref={body}>
          {tableRows.map((row, index) => {
            const key = groups ? groupKey(row.original, groups.by) : null;
            const header = groups && key !== null && (index === 0 || groupKey(tableRows[index - 1].original, groups.by) !== key);
            const summary = key ? groups?.summaries[key] : undefined;
            return <Fragment key={row.id}>
              {header && <tr><th colSpan={columns.length} scope="rowgroup" className="border-b border-border bg-card px-3 pb-1.5 pt-4 text-left">
                <span className="text-sm font-semibold">{groups.labels[key] ?? key}</span>
                {summary && <span className="ml-3 text-xs font-normal text-muted-foreground">{summary.count} {summary.count === 1 ? "transaction" : "transactions"} · <span className="font-mono">{Object.entries(summary.totals).map(([currency, minor]) => signed(minor, currency, locale)).join(" · ")}</span></span>}
              </th></tr>}
              <tr data-index={index} data-active={index === active || undefined} onClick={() => setActive(index)}
                className={`${index === active ? "bg-brand/10" : "hover:bg-muted"} ${row.original.id === openId ? "outline outline-1 -outline-offset-1 outline-brand" : ""}`}>
                {row.getAllCells().map(cell => <td key={cell.id} className={`max-w-xs border-b border-border px-3 py-1.5 ${cell.column.id === "amount" ? "whitespace-nowrap text-right" : ""}`}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}
              </tr>
            </Fragment>;
          })}
        </tbody>
      </table>
    </div>
    <p className="text-xs text-muted-foreground"><kbd>j</kbd>/<kbd>k</kbd> move · <kbd>Enter</kbd> open · <kbd>x</kbd> select · <kbd>/</kbd> search · <kbd>Esc</kbd> close</p>
    {targets.length > 0 && <BulkBar targets={targets} categories={categories} merchants={merchants} query={query} requestId={requestId} locale={locale} onClear={() => setSelected([])} />}
  </>;
}

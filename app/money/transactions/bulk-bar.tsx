"use client";

import { useState } from "react";
import { formatMoney } from "@/lib/finance/format";
import { bulkEditTransactions } from "./actions";

type Target = { id: string; version: number; description: string; amount_minor: string; currency_code: string; category_id: string | null; merchant_id: string | null; tags: string[] | null; event_name: string | null };
type Named = { id: string; name: string };
const MODES = { category: "Category", merchant: "Merchant", tags: "Tags", event: "Trip / event group" } as const;
type Mode = keyof typeof MODES;

/**
 * Bulk recategorize / re-merchant / tag the rows selected in the ledger.
 * Always shows the exact affected rows before applying; the batch is audited
 * and can be undone together from batch history.
 */
export function BulkBar({ targets, categories, merchants, query, requestId, locale, onClear }: {
  targets: Target[]; categories: Named[]; merchants: Named[]; query: string; requestId: string; locale: string; onClear: () => void;
}) {
  const [mode, setMode] = useState<Mode>("category");
  const [value, setValue] = useState("");
  const [preview, setPreview] = useState(false);
  const options = mode === "category" ? categories : mode === "merchant" ? merchants : null;
  const name = (list: Named[], id: string | null, empty: string) => list.find(item => item.id === id)?.name ?? empty;
  const next = options ? name(options, value || null, mode === "category" ? "Uncategorized" : "Unknown merchant") : value || "empty";
  const current = (row: Target) => mode === "category" ? name(categories, row.category_id, "Uncategorized") : mode === "merchant" ? name(merchants, row.merchant_id, "Unknown merchant")
    : mode === "tags" ? row.tags?.join(", ") || "no tags" : row.event_name || "no group";
  const change = (fn: () => void) => { fn(); setPreview(false); };
  const control = "min-h-9 rounded-lg border border-border bg-card px-2 py-1.5 text-sm";
  return <section aria-label="Bulk edit" className="sticky bottom-4 z-20 rounded-xl border border-brand/40 bg-card p-3 shadow-lg">
    <form action={bulkEditTransactions} className="space-y-3">
      <input type="hidden" name="rows" value={JSON.stringify(targets.map(row => ({ id: row.id, version: row.version })))} />
      <input type="hidden" name="requestId" value={requestId} /><input type="hidden" name="query" value={query} />
      <input type="hidden" name="mode" value={mode} /><input type="hidden" name="value" value={value} />
      <div className="flex flex-wrap items-end gap-2">
        <p className="mr-2 self-center text-sm font-medium">{targets.length} selected</p>
        <label className="text-xs text-muted-foreground">Change<select value={mode} onChange={event => change(() => { setMode(event.target.value as Mode); setValue(""); })} className={`${control} block text-foreground`}>
          {Object.entries(MODES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        {options ? <label className="text-xs text-muted-foreground">{MODES[mode]}<select value={value} onChange={event => change(() => setValue(event.target.value))} className={`${control} block text-foreground`}>
          <option value="">{mode === "category" ? "Uncategorized" : "Unknown merchant"}</option>{options.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select></label> : <label className="text-xs text-muted-foreground">{mode === "tags" ? "Tags, separated by commas" : "Group name"}<input value={value} maxLength={mode === "event" ? 120 : 1000} onChange={event => change(() => setValue(event.target.value))} className={`${control} block text-foreground`} /></label>}
        <button type="button" onClick={() => setPreview(true)} className="min-h-9 rounded-lg border border-border px-3 text-sm font-medium hover:bg-muted">Preview changes</button>
        <button type="button" onClick={onClear} className="min-h-9 px-2 text-sm text-muted-foreground underline">Clear selection</button>
      </div>
      {preview && <div className="rounded-lg bg-muted p-3 text-sm" role="region" aria-label="Bulk impact preview">
        <p className="font-medium">{targets.length} selected transactions: set {MODES[mode].toLowerCase()} to {next}.</p>
        <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">{targets.map(row => <li key={row.id}>{row.description} · {formatMoney(row.amount_minor, row.currency_code, locale)} · currently {current(row)}</li>)}</ul>
        <p className="mt-2 text-muted-foreground">Amounts, currencies, source records and transfer/refund links stay the same. You can undo the whole batch from batch history.</p>
        <button name="confirmed" value="true" className="mt-3 rounded-lg bg-brand px-4 py-2 font-medium text-white">Apply to {targets.length} transactions</button>
      </div>}
    </form>
  </section>;
}

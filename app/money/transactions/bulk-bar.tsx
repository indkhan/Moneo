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
 * Category is a searchable text field over existing categories; a name with no
 * match is created on apply. Always shows the exact affected rows before
 * applying; the batch is audited and can be undone together from batch history.
 */
export function BulkBar({ targets, categories, merchants, query, requestId, locale, onClear }: {
  targets: Target[]; categories: Named[]; merchants: Named[]; query: string; requestId: string; locale: string; onClear: () => void;
}) {
  const [mode, setMode] = useState<Mode>("category");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(false);
  const name = (list: Named[], id: string | null, empty: string) => list.find(item => item.id === id)?.name ?? empty;
  const typed = text.trim();
  const match = mode === "category" ? categories.find(item => item.name.toLowerCase() === typed.toLowerCase()) : undefined;
  const newCategory = mode === "category" && typed && !match ? typed : "";
  const value = mode === "category" ? match?.id ?? "" : text;
  const next = mode === "category" ? match?.name ?? (newCategory ? `${newCategory} (new category)` : "Uncategorized")
    : mode === "merchant" ? name(merchants, value || null, "Unknown merchant") : value || "empty";
  const current = (row: Target) => mode === "category" ? name(categories, row.category_id, "Uncategorized") : mode === "merchant" ? name(merchants, row.merchant_id, "Unknown merchant")
    : mode === "tags" ? row.tags?.join(", ") || "no tags" : row.event_name || "no group";
  const change = (fn: () => void) => { fn(); setPreview(false); };
  const control = "min-h-9 rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm text-foreground";
  return <section aria-label="Bulk edit" className="sticky bottom-4 z-20 rounded-xl border border-border bg-card p-3 shadow-lg">
    <form action={bulkEditTransactions} className="space-y-3">
      <input type="hidden" name="rows" value={JSON.stringify(targets.map(row => ({ id: row.id, version: row.version })))} />
      <input type="hidden" name="requestId" value={requestId} /><input type="hidden" name="query" value={query} />
      <input type="hidden" name="mode" value={mode} /><input type="hidden" name="value" value={value} /><input type="hidden" name="newCategory" value={newCategory} />
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-1 text-sm font-medium">{targets.length} selected</p>
        <select aria-label="Change" value={mode} onChange={event => change(() => { setMode(event.target.value as Mode); setText(""); })} className={control}>
          {Object.entries(MODES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        {mode === "category" ? <>
          <input aria-label="Category" list="bulk-categories" value={text} maxLength={100} placeholder="Search or create a category" onChange={event => change(() => setText(event.target.value))} className={`${control} w-56`} />
          <datalist id="bulk-categories">{categories.map(option => <option key={option.id} value={option.name} />)}</datalist>
        </> : mode === "merchant" ? <select aria-label="Merchant" value={text} onChange={event => change(() => setText(event.target.value))} className={control}>
          <option value="">Unknown merchant</option>{merchants.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select> : <input aria-label={mode === "tags" ? "Tags, separated by commas" : "Group name"} placeholder={mode === "tags" ? "Tags, separated by commas" : "Group name"} value={text} maxLength={mode === "event" ? 120 : 1000} onChange={event => change(() => setText(event.target.value))} className={`${control} w-56`} />}
        <button type="button" onClick={() => setPreview(true)} className="min-h-9 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90">Preview changes</button>
        <button type="button" onClick={onClear} className="ml-auto min-h-9 px-2 text-sm text-muted-foreground hover:text-foreground">Clear selection</button>
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

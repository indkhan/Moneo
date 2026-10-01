"use client";

import { useState } from "react";
import { formatMoney } from "@/lib/finance/format";
import { bulkEditTransactions } from "./actions";

type Row = { id: string; version: number; description: string; posted_on: string; amount_minor: string; currency_code: string; category_id: string | null; tags: string[]; event_name: string | null };

export function BulkEditor({ rows, categories, query, requestId }: { rows: Row[]; categories: { id: string; name: string }[]; query: string; requestId: string }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState("category");
  const [value, setValue] = useState("");
  const [preview, setPreview] = useState(false);
  const targets = rows.filter(row => selected.includes(row.id));
  return <details className="rounded-xl border border-border bg-card p-4">
    <summary className="cursor-pointer text-sm font-semibold">Bulk categories, tags and spending groups</summary>
    <p className="mt-2 text-sm text-muted-foreground">Select from this page (up to 50). Tags and groups replace the selected entries’ current values. Review the exact affected entries before applying.</p>
    <form action={bulkEditTransactions} className="mt-3 space-y-3">
      <input type="hidden" name="rows" value={JSON.stringify(targets.map(row => ({ id: row.id, version: row.version })))} />
      <input type="hidden" name="requestId" value={requestId} /><input type="hidden" name="query" value={query} />
      <input type="hidden" name="mode" value={mode} /><input type="hidden" name="value" value={value} />
      <div className="max-h-56 space-y-2 overflow-y-auto rounded-lg border p-3">{rows.map(row => <label key={row.id} className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={selected.includes(row.id)} onChange={event => { setPreview(false); setSelected(event.target.checked ? [...selected, row.id] : selected.filter(id => id !== row.id)); }} className="mt-1" />
        <span>{row.posted_on} · {row.description} · {formatMoney(row.amount_minor, row.currency_code)}</span>
      </label>)}</div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">Change<select value={mode} onChange={event => { setMode(event.target.value); setValue(""); setPreview(false); }} className="mt-1 block rounded-lg border bg-card p-2">
          <option value="category">Category</option><option value="tags">Tags</option><option value="event">Trip / event group</option>
        </select></label>
        {mode === "category" ? <label className="text-sm">Category<select value={value} onChange={event => { setValue(event.target.value); setPreview(false); }} className="mt-1 block rounded-lg border bg-card p-2">
          <option value="">Uncategorized</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select></label> : <label className="text-sm">{mode === "tags" ? "Tags, separated by commas" : "Group name"}<input value={value} maxLength={mode === "event" ? 120 : 1000} onChange={event => { setValue(event.target.value); setPreview(false); }} className="mt-1 block rounded-lg border bg-card p-2" /></label>}
        <button type="button" disabled={!targets.length} onClick={() => setPreview(true)} className="rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-40">Preview changes</button>
      </div>
      {preview && <div className="rounded-lg border border-brand/30 bg-muted p-4 text-sm" role="region" aria-label="Bulk impact preview">
        <p className="font-medium">{targets.length} selected transactions: set {mode} to {mode === "category" ? categories.find(category => category.id === value)?.name ?? "Uncategorized" : value || "empty"}.</p>
        <ul className="mt-2 space-y-1">{targets.map(row => <li key={row.id}>{row.description} · {formatMoney(row.amount_minor, row.currency_code)} · currently {mode === "category" ? categories.find(category => category.id === row.category_id)?.name ?? "Uncategorized" : mode === "tags" ? row.tags.join(", ") || "no tags" : row.event_name || "no group"}</li>)}</ul>
        <p className="mt-2 text-muted-foreground">Amounts, currencies, source records and transfer/refund links stay intact. Changes are audited and can be undone together from batch history.</p>
        <button name="confirmed" value="true" className="mt-3 rounded-lg bg-brand px-4 py-2 font-medium text-white">Apply to {targets.length} transactions</button>
      </div>}
    </form>
  </details>;
}

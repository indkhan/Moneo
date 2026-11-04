"use client";

import { useState } from "react";
import { SafeForm } from "@/components/safe-form";
import { bulkEditTransactionsSafely } from "@/app/money/transactions/actions";
import { formatMoney } from "@/lib/finance/format";

type Row = { id: string; version: number; description: string; posted_on: string; amount_minor: string; currency_code: string; category_id: string | null };

/** Approving a category proposal: every entry, its current and new category, and one Apply. A refusal stays on this page with the selection. */
export function CategoryApproval({ rows, category, names, requestId, locale }: { rows: Row[]; category: { id: string; name: string }; names: Record<string, string>; requestId: string; locale: string }) {
  const [selected, setSelected] = useState(rows.map(row => row.id));
  const targets = rows.filter(row => selected.includes(row.id));
  // Net of inflows and outflows, for what is ticked right now; currencies never mix.
  const totals = new Map<string, bigint>();
  for (const row of targets) totals.set(row.currency_code, (totals.get(row.currency_code) ?? 0n) + BigInt(row.amount_minor));
  return <SafeForm action={bulkEditTransactionsSafely} className="space-y-4">
    <input type="hidden" name="rows" value={JSON.stringify(targets.map(row => ({ id: row.id, version: row.version })))} />
    <input type="hidden" name="requestId" value={requestId} />
    <input type="hidden" name="query" value={new URLSearchParams({ category: category.id, applied: String(targets.length) }).toString()} />
    <input type="hidden" name="mode" value="category" /><input type="hidden" name="value" value={category.id} /><input type="hidden" name="confirmed" value="true" />
    <ul aria-label="Entries to change" className="divide-y divide-border rounded-xl border border-border bg-card">{rows.map(row => <li key={row.id}>
      <label className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3 text-sm">
        <input type="checkbox" className="mt-0.5" checked={selected.includes(row.id)} onChange={event => setSelected(current => event.target.checked ? [...current, row.id] : current.filter(id => id !== row.id))} />
        <span className="min-w-0 flex-1 break-words"><span className="font-medium">{row.description}</span> <span className="font-mono text-xs text-muted-foreground">{row.posted_on}</span>
          <span className="block text-xs text-muted-foreground">{row.category_id === category.id ? `Already in ${category.name}, no change` : `${(row.category_id && names[row.category_id]) || "Uncategorized"} → ${category.name}`}</span></span>
        <span className="font-mono tabular-nums">{formatMoney(row.amount_minor, row.currency_code, locale)}</span>
      </label></li>)}</ul>
    <p aria-live="polite" className="text-sm">{targets.length} selected{totals.size > 0 && <>, net {[...totals].map(([currency, amount]) => formatMoney(amount.toString(), currency, locale)).join(" · ")}. Separate currencies stay separate</>}.</p>
    <p className="text-sm text-muted-foreground">Amounts, currencies, source records and links stay as they are. You can undo this batch from Transactions.</p>
    <button disabled={!targets.length} className="min-h-10 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">Apply to {targets.length} {targets.length === 1 ? "transaction" : "transactions"}</button>
  </SafeForm>;
}

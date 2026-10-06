"use client";

import { useState } from "react";
import { splitTransaction } from "./actions";
import { splitInput } from "./input";
import { formatMoney as formatCurrency } from "@/lib/finance/format";

export function SplitEditor({ id, version, amountMinor, currency, categories, query, requestId, locale }: {
  id: string; version: number; amountMinor: string; currency: string; categories: { id: string; name: string }[]; query: string; requestId: string; locale?:string;
}) {
  const formatMoney=(amount:Parameters<typeof formatCurrency>[0],currency:string)=>formatCurrency(amount,currency,locale);
  const [rows, setRows] = useState([{ amount: "", categoryId: "", note: "" }, { amount: "", categoryId: "", note: "" }]);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = rows.map(row => ({ ...row, categoryId: row.categoryId || null }));
  function change(index: number, key: "amount" | "categoryId" | "note", value: string) {
    setRows(rows.map((row, i) => i === index ? { ...row, [key]: value } : row)); setPreview(false); setError(null);
  }
  return <details className="mt-5 rounded border p-4"><summary className="cursor-pointer font-medium">Split into categories</summary>
    <p className="mt-2 text-sm text-muted-foreground">Allocate {formatMoney(amountMinor, currency)} without changing the original amount, source or category. Balances count the original once; spending uses these allocations. Undo splits before linking transfers or refunds.</p>
    <form action={splitTransaction} className="mt-3 space-y-3">
      <input type="hidden" name="id" value={id} /><input type="hidden" name="version" value={version} /><input type="hidden" name="requestId" value={requestId} /><input type="hidden" name="query" value={query} /><input type="hidden" name="children" value={JSON.stringify(input)} />
      {rows.map((row, index) => <fieldset key={index} className="flex flex-wrap items-end gap-2 rounded border p-3"><legend className="text-xs">Allocation {index + 1}</legend>
        <label className="text-xs">Signed decimal amount ({currency})<input value={row.amount} onChange={event => change(index, "amount", event.target.value)} required className="block rounded border p-2" /></label>
        <label className="text-xs">Category<select value={row.categoryId} onChange={event => change(index, "categoryId", event.target.value)} className="block rounded border p-2"><option value="">Uncategorized</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
        <label className="text-xs">Allocation note<input value={row.note} maxLength={500} onChange={event => change(index, "note", event.target.value)} className="block rounded border p-2" /></label>
        {rows.length > 2 && <button type="button" onClick={() => { setRows(rows.filter((_, i) => i !== index)); setPreview(false); }} className="text-xs underline">Remove allocation</button>}
      </fieldset>)}
      {rows.length < 20 && <button type="button" onClick={() => { setRows([...rows, { amount: "", categoryId: "", note: "" }]); setPreview(false); }} className="mr-3 text-sm underline">Add allocation</button>}
      <button type="button" onClick={() => { try { splitInput(input, currency, BigInt(amountMinor)); setPreview(true); setError(null); } catch (error) { setError(error instanceof Error ? error.message : "Invalid allocations"); } }} className="rounded border px-3 py-2 text-sm">Preview splits</button>
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
      {preview && <div className="rounded bg-muted p-3 text-sm"><p>Replace spending classification with {rows.length} allocations totaling exactly {formatMoney(amountMinor, currency)}. The source remains unchanged.</p><ul className="my-2">{splitInput(input, currency, BigInt(amountMinor)).map((row, index) => <li key={index}>{formatMoney(row.amount_minor, currency)} · {categories.find(category => category.id === row.category_id)?.name ?? "Uncategorized"} · {row.note}</li>)}</ul><button name="confirmed" value="true" className="rounded bg-primary px-3 py-2 text-primary-foreground">Confirm splits</button></div>}
    </form>
  </details>;
}

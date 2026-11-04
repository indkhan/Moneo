"use client";

import { useState } from "react";
import { SafeForm } from "@/components/safe-form";
import { splitTransactionSafely } from "./actions";
import { parseManualAmount, splitInput } from "./input";
import { formatMoney as formatCurrency } from "@/lib/finance/format";

export function SplitEditor({ id, version, amountMinor, currency, categories, query, requestId, locale }: {
  id: string; version: number; amountMinor: string; currency: string; categories: { id: string; name: string }[]; query: string; requestId: string; locale?:string;
}) {
  const formatMoney=(amount:Parameters<typeof formatCurrency>[0],currency:string)=>formatCurrency(amount,currency,locale);
  const [rows, setRows] = useState([{ amount: "", categoryId: "", note: "" }, { amount: "", categoryId: "", note: "" }]);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parent = BigInt(amountMinor), total = parent < 0n ? -parent : parent;
  // Typed as plain amounts; each takes the source's direction.
  const signed = (amount: string) => { const plain = amount.trim().replace(/^-/, ""); return plain && parent < 0n ? `-${plain}` : plain; };
  const input = rows.map(row => ({ ...row, amount: signed(row.amount), categoryId: row.categoryId || null }));
  let allocated: bigint | null = 0n;
  for (const row of rows) { if (!row.amount.trim()) continue; try { const minor = parseManualAmount(row.amount.trim().replace(/^-/, ""), currency); allocated = allocated === null ? null : allocated + minor; } catch { allocated = null; } }
  const left = allocated === null ? null : total - allocated;
  function change(index: number, key: "amount" | "categoryId" | "note", value: string) {
    setRows(rows.map((row, i) => i === index ? { ...row, [key]: value } : row)); setPreview(false); setError(null);
  }
  return <details className="mt-5 rounded border p-4"><summary className="cursor-pointer font-medium">Split into categories</summary>
    <p className="mt-2 text-sm text-muted-foreground">Allocate {formatMoney(amountMinor, currency)} without changing the original amount, source or category. Balances count the original once; spending uses these allocations. Undo splits before linking transfers or refunds.</p>
    <SafeForm action={splitTransactionSafely} className="mt-3 space-y-3">
      <input type="hidden" name="id" value={id} /><input type="hidden" name="version" value={version} /><input type="hidden" name="requestId" value={requestId} /><input type="hidden" name="query" value={query} /><input type="hidden" name="children" value={JSON.stringify(input)} />
      {rows.map((row, index) => <fieldset key={index} className="flex flex-wrap items-end gap-2 rounded border p-3"><legend className="text-xs">Allocation {index + 1}</legend>
        <label className="text-xs">Amount ({currency})<input value={row.amount} onChange={event => change(index, "amount", event.target.value)} required inputMode="decimal" className="block rounded border p-2" /></label>
        <label className="text-xs">Category<select value={row.categoryId} onChange={event => change(index, "categoryId", event.target.value)} className="block rounded border p-2"><option value="">Uncategorized</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
        <label className="text-xs">Allocation note<input value={row.note} maxLength={500} onChange={event => change(index, "note", event.target.value)} className="block rounded border p-2" /></label>
        {rows.length > 2 && <button type="button" onClick={() => { setRows(rows.filter((_, i) => i !== index)); setPreview(false); }} className="text-xs underline">Remove allocation</button>}
      </fieldset>)}
      <p role="status" className={`text-sm ${left !== null && left < 0n ? "text-danger" : "text-muted-foreground"}`}>{left === null ? "Check the amounts: use digits and up to the currency’s decimals." : left === 0n ? `All ${formatMoney(total, currency)} allocated.` : left > 0n ? `${formatMoney(left, currency)} left to allocate of ${formatMoney(total, currency)}.` : `${formatMoney(-left, currency)} too much: the allocations must add up to ${formatMoney(total, currency)}.`}</p>
      {rows.length < 20 && <button type="button" onClick={() => { setRows([...rows, { amount: "", categoryId: "", note: "" }]); setPreview(false); }} className="mr-3 text-sm underline">Add allocation</button>}
      <button type="button" onClick={() => { try { splitInput(input, currency, BigInt(amountMinor)); setPreview(true); setError(null); } catch (error) { setError(error instanceof Error ? error.message : "Invalid allocations"); } }} className="rounded border px-3 py-2 text-sm">Preview splits</button>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {preview && <div className="rounded bg-muted p-3 text-sm"><p>Replace spending classification with {rows.length} allocations totaling exactly {formatMoney(amountMinor, currency)}. The source remains unchanged.</p><ul className="my-2">{splitInput(input, currency, BigInt(amountMinor)).map((row, index) => <li key={index}>{formatMoney(row.amount_minor, currency)} · {categories.find(category => category.id === row.category_id)?.name ?? "Uncategorized"} · {row.note}</li>)}</ul><input type="hidden" name="confirmed" value="true" /><button className="rounded bg-primary px-3 py-2 text-primary-foreground">Confirm splits</button></div>}
    </SafeForm>
  </details>;
}

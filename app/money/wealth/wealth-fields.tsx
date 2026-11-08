"use client";

import { useState } from "react";
import { saveWealthItemSafely } from "./actions";
import { CurrencySelect } from "@/components/currency-select";
import { SafeForm } from "@/components/safe-form";
import type { WealthItem } from "@/lib/finance/wealth";
import { formatInputAmount } from "@/lib/finance/format";

export function WealthFields({ itemId, requestId, kind, item, accounts, assumptions, pending, today, currency, locale }: { itemId: string; requestId: string; kind: WealthItem["kind"]; item?: WealthItem;
  accounts: { id: string; name: string; type: string; currency_code: string; archived_at?:string|null }[]; assumptions: { id: string; label: string; currency_code: string }[]; pending: { id: string; label: string; currency_code: string }[]; today: string; currency: string; locale?: string }) {
  // Which accounts and repayments can match this value follows the currency as it is chosen.
  const [code, setCode] = useState(item?.currency_code ?? currency);
  const field = "mt-1 block min-h-10 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground";
  return <SafeForm action={saveWealthItemSafely} className="mt-4 grid gap-x-4 gap-y-3 text-sm sm:grid-cols-2 [&_label]:text-muted-foreground">
    {!item && kind !== "debt" && <p className="text-xs text-muted-foreground sm:col-span-2">{kind === "holding" ? "Something with a quantity and a price, like shares or a fund." : "Something with one value, like a home or a car."}</p>}
    <input type="hidden" name="id" value={itemId} /><input type="hidden" name="version" value={item?.version ?? 0} /><input type="hidden" name="requestId" value={requestId} /><input type="hidden" name="kind" value={kind} />
    <label>Name<input name="name" required maxLength={120} defaultValue={item?.name} className={field} /></label>
    <label>Currency{item ? <input name="currency" readOnly value={code} className={field} /> : <span className="mt-1 block"><CurrencySelect name="currency" label="Currency" defaultValue={code} locale={locale} onChange={setCode} /></span>}</label>
    <label>Valuation as of<input name="asOf" required type="date" max={today} defaultValue={item?.as_of ?? today} className={field} /><span className="mt-1 block text-xs">The last known value counts. An older one stays counted and is shown as not from today.</span></label>
    {kind === "holding" ? <><label>Quantity<input name="quantity" required inputMode="decimal" defaultValue={item?.quantity_text ?? ""} placeholder="0.125" className={field} /></label><label>Unit price in currency<input name="unitPrice" required inputMode="decimal" defaultValue={item?.unit_price_text ?? ""} placeholder="80.04" className={field} /></label></> : <label>{kind === "debt" ? `Amount you still owe (${code})` : `Asset value (${code})`}<input name="amount" required inputMode="decimal" defaultValue={item ? formatInputAmount(BigInt(item.amount_minor) < 0n ? -BigInt(item.amount_minor) : item.amount_minor, code) : ""} placeholder="1000.00" className={field} />{kind === "debt" && <span className="mt-1 block text-xs">Enter a plain amount. It is deducted from your net worth.</span>}</label>}
    {kind !== "debt" && <label>Total cost basis (optional)<input name="costBasis" inputMode="decimal" defaultValue={item?.cost_basis_minor ? formatInputAmount(item.cost_basis_minor, code) : ""} className={field} /></label>}
    <label>Already included in an account balance<select name="linkedAccountId" defaultValue={item?.linked_account_id ?? ""} className={field}><option value="">No — count as standalone wealth</option>{accounts.filter(account => account.currency_code===code).map(account => <option key={account.id} value={account.id}>{account.name} ({account.currency_code})</option>)}</select></label>
    <label className="flex items-center gap-2 sm:col-span-2"><input name="standaloneConfirmed" type="checkbox" defaultChecked={!!item && !item.linked_account_id} />I confirm this standalone value is not already included in an account balance.</label>
    {kind === "debt" && <><label>Nominal annual interest rate (%)<input name="annualRate" required inputMode="decimal" defaultValue={item?.annual_rate_text ?? "0"} className={field} /></label><label>Monthly repayment (positive amount)<input name="monthlyPayment" required inputMode="decimal" defaultValue={item?.monthly_payment_minor ? formatInputAmount(item.monthly_payment_minor, code) : "0"} className={field} /></label>
      <label>Next repayment date<input name="nextPaymentOn" type="date" defaultValue={item?.next_payment_on ?? today} className={field} /></label>
      <label>Pay from liquid account<select name="paymentAccountId" defaultValue={item?.payment_account_id ?? ""} className={field}><option value="">Not set — forecast unavailable for repayments</option>{accounts.filter(account => account.currency_code===code && ["checking", "savings", "cash", "wallet"].includes(account.type) && (!account.archived_at || account.id===item?.payment_account_id)).map(account => <option key={account.id} value={account.id}>{account.name} ({account.currency_code})</option>)}</select></label>
      <details open={!!(item?.payment_assumption_id || item?.payment_transaction_id)} className="sm:col-span-2"><summary className="min-h-11 cursor-pointer content-center text-sm underline">Avoid duplicate repayments (optional)</summary>
      <p className="mt-1 text-xs text-muted-foreground">Already have this repayment on your schedule or as a pending payment? Link it so the forecast does not count it twice. It must match account, currency, date and amount.</p>
      <div className="mt-3 grid gap-x-4 gap-y-3 sm:grid-cols-2"><label>Reuse an existing confirmed monthly repayment<select name="paymentAssumptionId" defaultValue={item?.payment_assumption_id ?? ""} className={field}><option value="">Add a new debt repayment schedule</option>{assumptions.filter(assumption => assumption.currency_code === code || assumption.id === item?.payment_assumption_id).map(assumption => <option key={assumption.id} value={assumption.id}>{assumption.label}</option>)}</select></label>
      <label>Already held as a pending payment<select name="paymentTransactionId" defaultValue={item?.payment_transaction_id ?? ""} className={field}><option value="">No matching pending hold</option>{pending.filter(transaction => transaction.currency_code === code || transaction.id === item?.payment_transaction_id).map(transaction => <option key={transaction.id} value={transaction.id}>{transaction.label}</option>)}</select></label></div></details>
      <p className="text-xs text-muted-foreground sm:col-span-2">Interest uses the yearly rate ÷ 12.</p></>}
    <button className="min-h-10 justify-self-start rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground sm:col-span-2">{item ? "Save wealth edit" : `Add ${kind === "holding" ? "investment" : kind}`}</button>
  </SafeForm>;
}

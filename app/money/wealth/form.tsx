import { saveWealthItem } from "./actions";
import type { WealthItem } from "@/lib/finance/wealth";
import { formatInputAmount } from "@/lib/finance/format";

export function WealthForm({ kind, item, accounts, assumptions, pending, today, currency }: { kind: WealthItem["kind"]; item?: WealthItem;
  accounts: { id: string; name: string; type: string; currency_code: string }[]; assumptions: { id: string; label: string }[]; pending: { id: string; label: string }[]; today: string; currency: string }) {
  const code = item?.currency_code ?? currency;
  const field = "block w-full rounded border border-border bg-background p-2";
  return <form action={saveWealthItem} className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
    <input type="hidden" name="id" value={item?.id ?? crypto.randomUUID()} /><input type="hidden" name="version" value={item?.version ?? 0} /><input type="hidden" name="requestId" value={crypto.randomUUID()} /><input type="hidden" name="kind" value={kind} />
    <label>Name<input name="name" required maxLength={120} defaultValue={item?.name} className={field} /></label>
    <label>Currency<input name="currency" required maxLength={3} readOnly={!!item} defaultValue={code} className={field} /></label>
    <label>Valuation as of<input name="asOf" required type="date" max={today} defaultValue={item?.as_of ?? today} className={field} /></label>
    {kind === "holding" ? <><label>Quantity<input name="quantity" required defaultValue={item?.quantity_text ?? ""} placeholder="0.125" className={field} /></label><label>Unit price in currency<input name="unitPrice" required defaultValue={item?.unit_price_text ?? ""} placeholder="80.04" className={field} /></label><p className="text-xs text-muted-foreground">Quantity and price use decimal dots. Value is calculated exactly and rounded to the nearest minor unit; half units round up.</p></> : <label>{kind === "debt" ? "Outstanding principal (negative amount)" : "Asset value"}<input name="amount" required defaultValue={item ? formatInputAmount(item.amount_minor, code) : ""} placeholder={kind === "debt" ? "-1000.00" : "1000.00"} className={field} /></label>}
    {kind !== "debt" && <label>Total cost basis (optional)<input name="costBasis" defaultValue={item?.cost_basis_minor ? formatInputAmount(item.cost_basis_minor, code) : ""} className={field} /></label>}
    <label>Already included in an account balance<select name="linkedAccountId" defaultValue={item?.linked_account_id ?? ""} className={field}><option value="">No — count as standalone wealth</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name} ({account.currency_code})</option>)}</select></label>
    <label className="flex items-center gap-2 text-xs"><input name="standaloneConfirmed" type="checkbox" defaultChecked={!!item && !item.linked_account_id} />I confirm this standalone value is not already included in an account balance.</label>
    {kind === "debt" && <><label>Nominal annual interest rate (%)<input name="annualRate" required defaultValue={item?.annual_rate_text ?? "0"} className={field} /></label><label>Monthly repayment (positive amount)<input name="monthlyPayment" required defaultValue={item?.monthly_payment_minor ? formatInputAmount(item.monthly_payment_minor, code) : "0"} className={field} /></label>
      <label>Next repayment date<input name="nextPaymentOn" type="date" defaultValue={item?.next_payment_on ?? today} className={field} /></label>
      <label>Pay from liquid account<select name="paymentAccountId" defaultValue={item?.payment_account_id ?? ""} className={field}><option value="">Not set — forecast unavailable for repayments</option>{accounts.filter(account => ["checking", "savings", "cash", "wallet"].includes(account.type)).map(account => <option key={account.id} value={account.id}>{account.name} ({account.currency_code})</option>)}</select></label>
      <label>Reuse an existing confirmed monthly repayment<select name="paymentAssumptionId" defaultValue={item?.payment_assumption_id ?? ""} className={field}><option value="">Add a new debt repayment schedule</option>{assumptions.map(assumption => <option key={assumption.id} value={assumption.id}>{assumption.label}</option>)}</select></label>
      <label>Already held as a pending payment<select name="paymentTransactionId" defaultValue={item?.payment_transaction_id ?? ""} className={field}><option value="">No matching pending hold</option>{pending.map(transaction => <option key={transaction.id} value={transaction.id}>{transaction.label}</option>)}</select></label>
      <p className="text-xs text-muted-foreground sm:col-span-2">Repayments are future assumptions. Interest uses the nominal annual rate divided by 12, rounded monthly, and the last payment is capped at payoff. Existing repayment or pending hold links must match the account, currency, date and amount. No duplicate obligation is added for an explicitly linked payment.</p></>}
    <p className="text-xs text-muted-foreground sm:col-span-2">Only standalone valuations dated today are included in current net worth. Earlier values remain visible as historical evidence. Wealth values never fund available-to-spend calculations.</p>
    <button className="rounded bg-primary px-4 py-2 text-primary-foreground sm:col-span-2">{item ? "Save wealth edit" : `Add ${kind}`}</button>
  </form>;
}

"use client";

import { useState } from "react";
import { SafeForm } from "@/components/safe-form";
import { createManualTransactionSafely } from "./actions";

const skin = "[&_input]:min-h-10 [&_input]:rounded-lg [&_input]:border [&_input]:border-border [&_input]:bg-card [&_input]:px-3 [&_input]:text-sm [&_select]:min-h-10 [&_select]:rounded-lg [&_select]:border [&_select]:border-border [&_select]:bg-card [&_select]:px-3 [&_select]:text-sm";

/** Money out or in plus a positive amount; the action turns that into the signed minor units the ledger stores. */
export function ManualTransactionForm({ accounts, categories, today, requestId }: {
  accounts: { id: string; name: string; currency_code: string }[]; categories: { id: string; name: string }[]; today: string; requestId: string;
}) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const currency = accounts.find(account => account.id === accountId)?.currency_code;
  return <SafeForm action={createManualTransactionSafely} className={`mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 ${skin}`}>
    <input type="hidden" name="requestId" value={requestId} />
    <label className="grid gap-1 text-sm">Account<select name="accountId" required value={accountId} onChange={event => setAccountId(event.target.value)}>{accounts.map(account => <option key={account.id} value={account.id}>{account.name} ({account.currency_code})</option>)}</select></label>
    <label className="grid gap-1 text-sm">Posting date<input name="postedOn" type="date" required defaultValue={today} /></label>
    <label className="grid gap-1 text-sm">Description<input name="description" required maxLength={500} /></label>
    <label className="grid gap-1 text-sm">Direction<select name="direction" defaultValue="out"><option value="out">Money out</option><option value="in">Money in</option></select></label>
    <label className="grid gap-1 text-sm">Amount ({currency})<input name="amount" required maxLength={30} inputMode="decimal" placeholder="12.34" /></label>
    <label className="grid gap-1 text-sm">Status<select name="status" defaultValue="posted"><option value="posted">Posted</option><option value="pending">Pending</option></select></label>
    <label className="grid gap-1 text-sm">Category<select name="categoryId"><option value="">Uncategorized</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
    <label className="grid gap-1 text-sm">Note<input name="note" maxLength={2000} /></label>
    <button className="min-h-10 self-end rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Add transaction</button>
  </SafeForm>;
}

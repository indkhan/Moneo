"use client";

import { useActionState } from "react";
import { editAccount } from "./actions";

export function AccountForm({ account, requestId }: { account: { id: string; name: string; type: string; version: number; archived_at: string | null }; requestId: string }) {
  const [state, action, pending] = useActionState(editAccount, {});
  const inputClass = "min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm";
  return <form action={action} className="flex flex-wrap items-end gap-3">
    <input type="hidden" name="accountId" value={account.id} /><input type="hidden" name="version" value={account.version} /><input type="hidden" name="requestId" value={requestId} />
    <label className="grid gap-1 text-sm">Name<input className={inputClass} name="name" defaultValue={account.name} required maxLength={120} /></label>
    <label className="grid gap-1 text-sm">Account type<select className={inputClass} name="type" defaultValue={account.type}>{["checking", "savings", "cash", "credit", "investment", "wallet", "other"].map(type => <option key={type} value={type}>{type[0].toUpperCase() + type.slice(1)}</option>)}</select></label>
    <button disabled={pending} className={inputClass} name="operation" value="edit">Save changes</button>
    <button disabled={pending} className={inputClass} name="operation" value={account.archived_at ? "restore" : "archive"}>{account.archived_at ? "Restore account" : "Archive account"}</button>
    {state.error ? <p role="alert" className="w-full text-sm text-red-700 dark:text-red-300">{state.error}</p> : null}
  </form>;
}

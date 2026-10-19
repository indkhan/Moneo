"use client";

import { useActionState } from "react";
import { editAccount, updateBalance } from "./actions";
import { accountTypes } from "./naming";


type Account = { id: string; name: string; type: string; version: number; archived_at: string | null };
const field = "min-h-9 rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm";
const quiet = "min-h-9 rounded-lg px-2.5 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50";
const Hidden = ({ account, requestId }: { account: Account; requestId: string }) => <>
  <input type="hidden" name="accountId" value={account.id} /><input type="hidden" name="version" value={account.version} /><input type="hidden" name="requestId" value={requestId} />
</>;
const ErrorText = ({ error }: { error?: string }) => error ? <p role="alert" className="w-full text-sm text-red-700 dark:text-red-300">{error}</p> : null;

// Inline rename/type: the name looks like text until focused. Archive keeps all history.
export function AccountForm({ account, requestId }: { account: Account; requestId: string }) {
  const [state, action, pending] = useActionState(editAccount, {});
  return <form action={action} className="flex min-w-0 flex-wrap items-center gap-2">
    <Hidden account={account} requestId={requestId} />
    <input aria-label="Name" name="name" defaultValue={account.name} required maxLength={120}
      className="min-h-9 min-w-0 flex-1 basis-48 rounded-lg border border-transparent bg-transparent px-2 py-1 text-base font-semibold hover:border-border focus:border-border focus:bg-card" />
    <select aria-label="Account type" name="type" defaultValue={account.type} className={quiet}>{accountTypes.map(type => <option key={type} value={type}>{type[0].toUpperCase() + type.slice(1)}</option>)}</select>
    <button disabled={pending} className={quiet} name="operation" value="edit">Save changes</button>
    <button disabled={pending} className={quiet} name="operation" value={account.archived_at ? "restore" : "archive"}>{account.archived_at ? "Restore account" : "Archive account"}</button>
    <ErrorText error={state.error} />
  </form>;
}

export function RenameSuggestion({ account, suggestion, requestId }: { account: Account; suggestion: string; requestId: string }) {
  const [state, action, pending] = useActionState(editAccount, {});
  return <form action={action} className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
    <Hidden account={account} requestId={requestId} /><input type="hidden" name="name" value={suggestion} /><input type="hidden" name="type" value={account.type} />
    <span>Named after the import file.</span>
    <button disabled={pending} name="operation" value="edit" className="rounded-full border border-border px-3 py-1 font-medium text-foreground hover:bg-muted">Rename to “{suggestion}”</button>
    <ErrorText error={state.error} />
  </form>;
}

export function BalanceForm({ accountId, name, currency, today, expectedSnapshotId, expectedVersion, requestId, placeholder }: {
  accountId: string; name: string; currency: string; today: string; expectedSnapshotId: string; expectedVersion: number; requestId: string; placeholder: string;
}) {
  const [state, action, pending] = useActionState(updateBalance, {});
  return <form action={action} className="flex flex-wrap items-end gap-2">
    <input type="hidden" name="accountId" value={accountId} /><input type="hidden" name="requestId" value={requestId} />
    <input type="hidden" name="expectedSnapshotId" value={expectedSnapshotId} /><input type="hidden" name="expectedVersion" value={expectedVersion} />
    <label className="grid gap-1 text-xs text-muted-foreground">Booked balance ({currency})
      <input name="amount" required inputMode="decimal" placeholder={placeholder} aria-label={`${name} balance`} className={`${field} w-36 font-mono text-foreground`} /></label>
    <label className="grid gap-1 text-xs text-muted-foreground">As of
      <input name="asOf" type="date" required defaultValue={today} max={today} aria-label="Balance as of" className={`${field} text-foreground`} /></label>
    <button disabled={pending} className="min-h-9 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">Save balance</button>
    <ErrorText error={state.error} />
  </form>;
}

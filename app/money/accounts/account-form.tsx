"use client";

import { useActionState, useState } from "react";
import { editAccount, updateBalance } from "./actions";
import { accountTypes } from "./naming";
import { ArchiveQuestion } from "./archive-question";


type Account = { id: string; name: string; type: string; version: number; archived_at: string | null };
const field = "min-h-9 rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm";
const quiet = "min-h-9 rounded-lg px-2.5 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50";
const Hidden = ({ account, requestId }: { account: Account; requestId: string }) => <>
  <input type="hidden" name="accountId" value={account.id} /><input type="hidden" name="version" value={account.version} /><input type="hidden" name="requestId" value={requestId} />
</>;
const ErrorText = ({ error }: { error?: string }) => error ? <p role="alert" className="w-full text-sm text-danger">{error}</p> : null;

// Inline rename/type: the name looks like text until focused. Archive keeps all history.
export function AccountForm({ account, requestId, moneyLeft, targets = [] }: { account: Account; requestId: string; moneyLeft?: string | null; targets?: { id: string; name: string; type?: string }[] }) {
  const [state, action, pending] = useActionState(editAccount, {});
  const [edited, setEdited] = useState(false);
  const [asking, setAsking] = useState(false);
  return <>
  <form action={action} onChange={() => setEdited(true)} className="flex min-w-0 flex-wrap items-center gap-2">
    <Hidden account={account} requestId={requestId} />
    <input aria-label={`Name of ${account.name}`} name="name" defaultValue={account.name} required maxLength={120}
      className="min-h-9 min-w-0 flex-1 basis-48 rounded-lg border border-transparent bg-transparent px-2 py-1 text-base font-semibold hover:border-border focus:border-border focus:bg-card" />
    <select aria-label={`Type of ${account.name}`} name="type" defaultValue={account.type} className={quiet}>{accountTypes.map(type => <option key={type} value={type}>{type[0].toUpperCase() + type.slice(1)}</option>)}</select>
    {edited && <button disabled={pending} aria-label={`Save changes to ${account.name}`} className={quiet} name="operation" value="edit">{pending ? "Saving…" : "Save changes"}</button>}
    <details className="relative"><summary className={`${quiet} inline-flex cursor-pointer list-none items-center`}>More</summary>
      {moneyLeft && !account.archived_at ? <button type="button" onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); setAsking(true); }} className={`${quiet} absolute right-0 z-10 mt-1 whitespace-nowrap border border-border bg-card shadow-sm`} aria-label={`Archive ${account.name}`}>Archive account</button> : <button disabled={pending} className={`${quiet} absolute right-0 z-10 mt-1 whitespace-nowrap border border-border bg-card shadow-sm`} name="operation" value={account.archived_at ? "restore" : "archive"} aria-label={`${account.archived_at ? "Restore" : "Archive"} ${account.name}. History is kept.`}>{account.archived_at ? "Restore account" : "Archive account"}</button>}
    </details>
    <ErrorText error={state.error} />
  </form>
  {asking && moneyLeft && <ArchiveQuestion account={account} amount={moneyLeft} targets={targets} requestId={requestId} onCancel={() => setAsking(false)} />}
  </>;
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

export function BalanceForm({ accountId, name, currency, today, expectedSnapshotId, expectedVersion, requestId, placeholder, review = [] }: {
  accountId: string; name: string; currency: string; today: string; expectedSnapshotId: string; expectedVersion: number; requestId: string; placeholder: string;
  review?: { id: string; label: string; covered: unknown }[];
}) {
  const [state, action, pending] = useActionState(updateBalance, {});
  const [asOf, setAsOf] = useState(today);
  return <form action={action} className="flex flex-wrap items-end gap-2">
    <input type="hidden" name="accountId" value={accountId} /><input type="hidden" name="requestId" value={requestId} />
    <input type="hidden" name="expectedSnapshotId" value={expectedSnapshotId} /><input type="hidden" name="expectedVersion" value={expectedVersion} />
    <label className="grid gap-1 text-xs text-muted-foreground">Booked balance ({currency})
      <input name="amount" required inputMode="decimal" placeholder={placeholder} aria-label={`${name} balance`} className={`${field} w-36 font-mono text-foreground`} /></label>
    <label className="grid gap-1 text-xs text-muted-foreground">As of
      <input name="asOf" type="date" required value={asOf} onChange={event => setAsOf(event.target.value)} max={today} aria-label={`${name} balance as of`} className={`${field} text-foreground`} /></label>
    <button disabled={pending} className="min-h-9 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">{pending ? "Saving…" : "Save balance"}</button>
    {review.length && asOf === today ? <details className="w-full text-xs" open>
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Today&apos;s activity ({review.length})</summary>
      <input type="hidden" name="coveredTransactions" value={JSON.stringify(review.map(row => row.covered))} />
      <ul className="mt-2 max-h-40 divide-y divide-border overflow-auto">{review.map(row => <li key={row.id} className="py-1">{row.label}</li>)}</ul>
      <label className="mt-2 flex items-start gap-2"><input type="checkbox" name="reviewedActivity" className="mt-0.5" /><span>For today&apos;s balance: it includes all {review.length} postings listed.</span></label>
    </details> : null}
    <ErrorText error={state.error} />
  </form>;
}

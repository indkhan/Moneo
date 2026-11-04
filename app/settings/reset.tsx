"use client";

import { useActionState, useState } from "react";
import { deleteAccount, resetAllData } from "./actions";

export function DeleteAccount({ email }: { email: string }) {
  const [state, action, pending] = useActionState(deleteAccount, {});
  const [typed, setTyped] = useState("");
  return <section aria-labelledby="delete-account" className="rounded-xl border border-danger/40 bg-card p-6">
    <h2 id="delete-account" className="text-sm font-medium text-danger">Delete account</h2>
    <p className="mt-1 break-words text-sm text-muted-foreground">Permanently deletes {email}, your workspace and everything in it, and disconnects your banks. This cannot be undone.</p>
    <form action={action} className="mt-4 flex flex-wrap items-end gap-3">
      <label className="grid gap-1.5 text-sm font-medium">Type DELETE to confirm
        <input name="confirmation" value={typed} onChange={event => setTyped(event.target.value)} autoComplete="off" spellCheck={false}
          className="min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm font-normal text-foreground" />
      </label>
      <button disabled={typed !== "DELETE" || pending} className="min-h-10 rounded-lg bg-danger px-4 py-2 text-sm font-medium text-background disabled:opacity-50">
        {pending ? "Deleting…" : "Delete account"}
      </button>
    </form>
    {state.error && <p role="alert" className="mt-3 text-sm text-danger">{state.error}</p>}
  </section>;
}

export function ResetData() {
  const [state, action, pending] = useActionState(resetAllData, {});
  const [typed, setTyped] = useState("");
  return <section className="rounded-xl border border-danger/40 bg-card p-6">
    <h2 className="text-sm font-medium text-danger">Danger zone</h2>
    <p className="mt-1 text-sm text-muted-foreground">Reset all data permanently deletes your accounts, transactions, imports, goals, plans, AI conversations and settings, leaving a fresh workspace. You stay signed in.</p>
    <form action={action} className="mt-4 flex flex-wrap items-end gap-3">
      <label className="grid gap-1.5 text-sm font-medium">Type RESET to confirm
        <input name="confirmation" value={typed} onChange={event => setTyped(event.target.value)} autoComplete="off" spellCheck={false}
          className="min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm font-normal text-foreground" />
      </label>
      <button disabled={typed !== "RESET" || pending} className="min-h-10 rounded-lg bg-danger px-4 py-2 text-sm font-medium text-background disabled:opacity-50">
        {pending ? "Resetting…" : "Reset all data"}
      </button>
    </form>
    {state.error && <p role="alert" className="mt-3 text-sm text-danger">{state.error}</p>}
  </section>;
}

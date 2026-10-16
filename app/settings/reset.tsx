"use client";

import { useActionState, useState } from "react";
import { resetAllData } from "./actions";

export function ResetData() {
  const [state, action, pending] = useActionState(resetAllData, {});
  const [typed, setTyped] = useState("");
  return <section className="rounded-xl border border-red-300 bg-card p-6 dark:border-red-900">
    <h2 className="text-base font-semibold text-red-700 dark:text-red-400">Danger zone</h2>
    <p className="mt-1 text-sm text-muted-foreground">Reset all data permanently deletes your accounts, transactions, imports, goals, plans, AI conversations, saved tools and settings, leaving a fresh workspace. You stay signed in.</p>
    <form action={action} className="mt-4 flex flex-wrap items-end gap-3">
      <label className="grid gap-1.5 text-sm font-medium">Type RESET to confirm
        <input name="confirmation" value={typed} onChange={event => setTyped(event.target.value)} autoComplete="off" spellCheck={false}
          className="min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm font-normal text-foreground" />
      </label>
      <button disabled={typed !== "RESET" || pending} className="min-h-10 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
        {pending ? "Resetting…" : "Reset all data"}
      </button>
    </form>
    {state.error && <p role="alert" className="mt-3 text-sm text-red-700">{state.error}</p>}
  </section>;
}

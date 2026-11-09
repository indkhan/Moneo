"use client";

import { useActionState, useState } from "react";
import { archiveWithAnswer } from "./actions";

type Target = { id: string; name: string; type?: string; bankSynced?: boolean };
const field = "min-h-11 w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm sm:min-h-9 sm:w-auto";

/** Asked before archiving an account that still holds money, so net worth can't drop without an answer. */
export function ArchiveQuestion({ account, amount, targets, requestId, onCancel }: { account: { id: string; name: string; version: number }; amount: string; targets: Target[]; requestId: string; onCancel: () => void }) {
  const [state, action, pending] = useActionState(archiveWithAnswer, {});
  const [outcome, setOutcome] = useState<"moved" | "cash" | "gone">();
  const [targetId, setTargetId] = useState("");
  const toBank = outcome === "moved" && targets.find(target => target.id === targetId)?.bankSynced;
  const cash = targets.filter(target => target.type === "cash");
  const choices = outcome === "moved" ? targets : outcome === "cash" && cash.length > 1 ? cash : [];
  return <form action={action} className="mt-2 basis-full space-y-3 rounded-lg border border-border bg-card p-3 text-sm">
    <input type="hidden" name="accountId" value={account.id} /><input type="hidden" name="version" value={account.version} /><input type="hidden" name="requestId" value={requestId} />
    <fieldset className="space-y-2"><legend className="font-medium">{account.name} still holds {amount}. What happens to it?</legend>
      <label className="flex min-h-11 items-center gap-2 sm:min-h-0"><input type="radio" name="outcome" value="moved" disabled={!targets.length} onChange={() => setOutcome("moved")} /> I moved it to another of my accounts</label>
      <label className="flex min-h-11 items-center gap-2 sm:min-h-0"><input type="radio" name="outcome" value="cash" onChange={() => setOutcome("cash")} /> I took it out as cash</label>
      <label className="flex min-h-11 items-center gap-2 sm:min-h-0"><input type="radio" name="outcome" value="gone" onChange={() => setOutcome("gone")} /> It&apos;s gone</label>
    </fieldset>
    {choices.length > 0 && <label className="flex flex-wrap items-center gap-2"><span className="text-muted-foreground">To</span>
      <select name="targetAccountId" required className={field} value={targetId} onChange={event => setTargetId(event.target.value)}><option value="">Choose an account</option>{choices.map(target => <option key={target.id} value={target.id}>{target.name}</option>)}</select></label>}
    {outcome && <p className="text-xs text-muted-foreground">{outcome === "gone" ? "It counts as money that left today, and net worth goes down by that much." : toBank ? "It's recorded as leaving this account today. Your bank's own row completes the transfer, and the money counts once your bank shows it." : `It's recorded as your own transfer today, so net worth stays the same${outcome === "cash" && !cash.length ? ", in a new Cash account" : ""}.`} The account stays in past days until today.</p>}
    {state.error && <p role="alert" className="text-sm text-danger">{state.error}</p>}
    <div className="flex flex-wrap gap-2"><button disabled={pending || !outcome} className="min-h-11 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50 sm:min-h-9">{pending ? "Archiving…" : "Archive account"}</button>
      <button type="button" onClick={onCancel} className="min-h-11 rounded-lg border border-border px-4 text-sm hover:bg-muted sm:min-h-9">Keep it</button></div>
  </form>;
}

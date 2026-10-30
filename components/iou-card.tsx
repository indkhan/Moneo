"use client";

import { useEffect, useState } from "react";
import { useBusy } from "@/components/use-busy";
import Link from "next/link";
import { decideAgentProposals } from "@/app/ai/agents/actions";
import { loadIouProposal, type ChatProposal } from "@/app/ai/iou-actions";

type Proposal = Pick<ChatProposal, "id" | "title" | "detail" | "status"> & Partial<ChatProposal> & { conflict_key?: string };
const NEW_CASH = "";

/** A loan, repayment or expense waiting for a yes/no. Nothing is saved until Add is pressed. */
export function IouCard({ id, initial, onAccount }: { id: string; initial?: Proposal; onAccount?: (id: string, accountId: string | undefined) => void }) {
  const [proposal, setProposal] = useState<Proposal | null | undefined>(initial);
  const [account, setAccount] = useState<string>();
  const [error, setError] = useState<string>();
  const [pending, start] = useBusy();
  const [unavailable, setUnavailable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // A failed load used to hide the card until the page was reloaded; it now says so and can be retried.
  useEffect(() => { if (!initial) loadIouProposal(id).then(setProposal, () => setUnavailable(true)); }, [id, initial, attempt]);
  if (unavailable) return <p role="alert" className="my-3 text-sm text-danger">Could not load this card. <button type="button" onClick={() => { setUnavailable(false); setAttempt(count => count + 1); }} className="underline">Try again</button></p>;
  if (proposal === undefined) return <p className="my-3 text-sm text-muted-foreground" role="status">Loading…</p>;
  if (!proposal) return null;
  const transaction = proposal.kind === "transaction_create";
  const balance = proposal.kind === "balance_set";
  const recurring = proposal.kind === "recurring_edit";
  const chosen = account ?? proposal.selected ?? NEW_CASH;
  const decide = (decision: "accept" | "reject") => start(async () => {
    setError(undefined);
    try {
      const [outcome] = await decideAgentProposals([id], decision, transaction && chosen ? chosen : undefined);
      if (outcome.error) setError(outcome.error);
      // Reload so an accepted card links to what it created.
      else setProposal(await loadIouProposal(id));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save"); }
  });
  const open = proposal.status === "proposed" || proposal.status === "failed";
  const done = transaction ? <>Added. {proposal.result?.href && <Link href={proposal.result.href} className="underline">Open transaction</Link>}
    {proposal.result?.createdAccount && <> A Cash account was created; <Link href="/money/accounts" className="underline">set its balance</Link> to count it in net worth.</>}</>
    : balance ? <>Saved. <Link href="/money/accounts" className="underline">See it on Accounts</Link></>
    : recurring ? <>Saved. <Link href="/money/recurring" className="underline">See it on Recurring</Link></>
    : <>Added. <Link href="/money/wealth" className="underline">See it in Wealth</Link></>;
  return <section aria-label={transaction ? "Transaction proposal" : balance ? "Balance proposal" : recurring ? "Recurring proposal" : "Loan proposal"} className="my-3 rounded-xl border border-ai-border bg-ai-soft p-4">
    <p className="font-medium">{proposal.title}</p>
    {proposal.detail && <p className="mt-1 text-sm text-muted-foreground">{proposal.detail}</p>}
    {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    {open ? <div className="mt-3 flex flex-wrap items-center gap-2">
      {transaction && proposal.accounts && <label className="flex items-center gap-2 text-sm"><span className="text-muted-foreground">From</span>
        <select value={chosen} onChange={event => { setAccount(event.target.value); onAccount?.(id, event.target.value || undefined); }} disabled={pending} className="min-h-9 rounded-lg border border-border bg-background px-2 text-sm">
          {proposal.needsCash && <option value={NEW_CASH}>Cash (new account)</option>}
          {proposal.accounts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>}
      <button type="button" disabled={pending} onClick={() => decide("accept")} className="min-h-9 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">{proposal.conflict_key?.startsWith("recurring_new:") ? "Yes, recurring" : recurring ? "Confirm" : balance ? "Save" : "Add"}</button>
      <button type="button" disabled={pending} onClick={() => decide("reject")} className="min-h-9 rounded-lg border border-border px-4 text-sm hover:bg-muted disabled:opacity-50">{proposal.conflict_key?.startsWith("recurring_new:") ? "Not recurring" : proposal.conflict_key?.startsWith("recurring_price:") ? "Keep old amount" : "Dismiss"}</button>
    </div> : <p role="status" className="mt-2 text-sm">{proposal.status === "accepted" ? done : recurring ? "Dismissed. It won’t be suggested again." : "Dismissed. Nothing was changed."}</p>}
  </section>;
}

"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { decideAgentProposals } from "@/app/ai/agents/actions";
import { loadIouProposal } from "@/app/ai/iou-actions";

type Proposal = { id: string; title: string; detail: string; status: string; result?: { error?: string } | null };

/** A loan or repayment waiting for a yes/no. Nothing reaches Wealth until Add is pressed. */
export function IouCard({ id, initial }: { id: string; initial?: Proposal }) {
  const [proposal, setProposal] = useState<Proposal | null | undefined>(initial);
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  useEffect(() => { if (!initial) loadIouProposal(id).then(setProposal, () => setProposal(null)); }, [id, initial]);
  if (proposal === undefined) return <p className="my-3 text-sm text-muted-foreground" role="status">Loading…</p>;
  if (!proposal) return null;
  const decide = (decision: "accept" | "reject") => start(async () => {
    setError(undefined);
    try {
      const [outcome] = await decideAgentProposals([id], decision);
      if (outcome.error) setError(outcome.error);
      else if (outcome.status === "unchanged") setProposal(await loadIouProposal(id));
      else setProposal({ ...proposal, status: outcome.status });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save"); }
  });
  const open = proposal.status === "proposed" || proposal.status === "failed";
  return <section aria-label="Loan proposal" className="my-3 rounded-xl border border-ai-border bg-ai-soft p-4">
    <p className="font-medium">{proposal.title}</p>
    <p className="mt-1 text-sm text-muted-foreground">{proposal.detail}</p>
    {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    {open ? <div className="mt-3 flex gap-2">
      <button type="button" disabled={pending} onClick={() => decide("accept")} className="min-h-9 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">Add</button>
      <button type="button" disabled={pending} onClick={() => decide("reject")} className="min-h-9 rounded-lg border border-border px-4 text-sm hover:bg-muted disabled:opacity-50">Dismiss</button>
    </div> : <p role="status" className="mt-2 text-sm">{proposal.status === "accepted" ? <>Added. <Link href="/money/wealth" className="underline">See it in Wealth</Link></> : "Dismissed. Nothing was changed."}</p>}
  </section>;
}

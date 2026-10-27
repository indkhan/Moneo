"use client";

import { useState, useTransition } from "react";
import { z } from "zod";
import { decideAgentProposals } from "@/app/ai/agents/actions";
import { IouCard } from "./iou-card";

const idsSchema = z.array(z.uuid()).min(2).max(50);

/** Several cards from one answer: each can be decided alone, or all added at once with the account chosen on each card. */
export function ProposalGroup({ source }: { source: string }) {
  let ids: string[] | null = null;
  try { ids = idsSchema.parse(JSON.parse(source)); } catch { /* not a group block */ }
  const [accounts, setAccounts] = useState<Record<string, string | undefined>>({});
  const [round, setRound] = useState(0);
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  if (!ids) return null;
  const addAll = () => start(async () => {
    setError(undefined);
    const failed: string[] = [];
    // One at a time, so each keeps its own account; decided cards are left unchanged.
    for (const id of ids) {
      try { const [outcome] = await decideAgentProposals([id], "accept", accounts[id]); if (outcome.error) failed.push(outcome.error); }
      catch (cause) { failed.push(cause instanceof Error ? cause.message : "Could not save"); }
    }
    if (failed.length) setError(`${failed.length} could not be added: ${failed[0]}`);
    setRound(current => current + 1);
  });
  return <div className="my-3">
    {ids.map(id => <IouCard key={`${id}:${round}`} id={id} onAccount={(card, account) => setAccounts(current => ({ ...current, [card]: account }))} />)}
    {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    <button type="button" disabled={pending} onClick={addAll} className="min-h-9 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">{pending ? "Adding…" : `Add all ${ids.length}`}</button>
  </div>;
}

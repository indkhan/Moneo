"use client";

import { useState } from "react";
import { IouCard } from "@/components/iou-card";
import type { OpenProposal } from "@/lib/ai/open-proposals";

const FILTERS = [["loans", "Loans"], ["transactions", "Transactions"], ["balances", "Balances"], ["recurring", "Recurring"]] as const;
type Filter = (typeof FILTERS)[number][0];
const filterOf = (kind: string): Filter => kind.startsWith("iou_") ? "loans" : kind === "transaction_create" ? "transactions" : kind === "balance_set" ? "balances" : "recurring";

/** Open cards in one collapsible list. Filtered-out cards stay mounted (hidden), so a card decided here keeps its outcome. */
export function WaitingForYouList({ proposals }: { proposals: OpenProposal[] }) {
  const [filter, setFilter] = useState<Filter>();
  const present = FILTERS.filter(([key]) => proposals.some(proposal => filterOf(proposal.kind) === key));
  const chip = (active: boolean) => `rounded-md px-2 py-1 text-xs ${active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`;
  return <details open aria-label="Waiting for you">
    <summary className="cursor-pointer text-sm font-medium text-ai">Waiting for you · {proposals.length}</summary>
    {present.length > 1 && <div role="group" aria-label="Show" className="mt-2 inline-flex flex-wrap rounded-lg border border-border p-0.5">
      <button type="button" aria-pressed={!filter} onClick={() => setFilter(undefined)} className={chip(!filter)}>All</button>
      {present.map(([key, label]) => <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)} className={chip(filter === key)}>{label}</button>)}
    </div>}
    {proposals.map(proposal => <div key={proposal.id} hidden={!!filter && filterOf(proposal.kind) !== filter}><IouCard id={proposal.id} initial={proposal} /></div>)}
  </details>;
}

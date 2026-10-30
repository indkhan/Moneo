"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { IouCard } from "@/components/iou-card";
import type { OpenProposal } from "@/lib/ai/open-proposals";

const FILTERS = [["loans", "Loans"], ["transactions", "Transactions"], ["balances", "Balances"], ["recurring", "Recurring"]] as const;
type Filter = (typeof FILTERS)[number][0];
const filterOf = (kind: string): Filter => kind.startsWith("iou_") ? "loans" : kind === "transaction_create" ? "transactions" : kind === "balance_set" ? "balances" : "recurring";

/** Open cards in one collapsible list. Filtered-out cards stay mounted (hidden), so a card decided here keeps its outcome. */
export function WaitingForYouList({ proposals }: { proposals: OpenProposal[] }) {
  const [filter, setFilter] = useState<Filter>();
  const present = FILTERS.filter(([key]) => proposals.some(proposal => filterOf(proposal.kind) === key));
  const chip = (active: boolean) => `h-9 rounded-full border px-3.5 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ai ${active ? "border-foreground bg-foreground text-background" : "border-input text-muted-foreground hover:bg-muted hover:text-foreground"}`;
  return <details open aria-label="Waiting for you" className="group">
    <summary className="-mx-1 flex min-h-11 cursor-pointer list-none items-center gap-2.5 rounded-lg px-1 focus-visible:outline-2 focus-visible:outline-ai [&::-webkit-details-marker]:hidden">
      <span className="font-display text-lg font-semibold">Waiting for you</span>
      <span className="rounded-full bg-ai-soft px-2 py-0.5 text-xs font-medium text-ai tabular-nums">{proposals.length}</span>
      <ChevronDown className="ml-auto size-4 text-muted-foreground transition-transform group-not-open:-rotate-90" aria-hidden="true" />
    </summary>
    {present.length > 1 && <div role="group" aria-label="Show" className="mt-2 flex flex-wrap gap-1.5">
      <button type="button" aria-pressed={!filter} onClick={() => setFilter(undefined)} className={chip(!filter)}>All</button>
      {present.map(([key, label]) => <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)} className={chip(filter === key)}>{label}</button>)}
    </div>}
    {proposals.map(proposal => <div key={proposal.id} hidden={!!filter && filterOf(proposal.kind) !== filter}><IouCard id={proposal.id} initial={proposal} /></div>)}
  </details>;
}

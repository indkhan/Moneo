"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { IouCard } from "@/components/iou-card";
import type { OpenProposal } from "@/lib/ai/open-proposals";
import type { HomeReview } from "@/lib/ai/home-review";
import { useBusy } from "@/components/use-busy";
import { decideAgentProposals } from "@/app/ai/agents/actions";
import { FindingsSheet, RecurringSheet, SummaryCard, UncategorizedSheet } from "./home-review";

const FILTERS = [["loans", "Loans"], ["transactions", "Transactions"], ["balances", "Balances"], ["organize", "Labels"]] as const;
type Filter = (typeof FILTERS)[number][0];
const filterOf = (kind: string): Filter => kind.startsWith("iou_") ? "loans" : kind === "transaction_create" ? "transactions" : kind === "organize_answer" ? "organize" : "balances";
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
// Home answers where you stand first; the rest of the queue is a press away and stays mounted.
const VISIBLE = 3;

/** Identical expense proposals together, in first-seen order: adding each by habit would record one purchase many times. */
export function groupRepeats(proposals: OpenProposal[]) {
  const groups = new Map<string, OpenProposal[]>();
  for (const proposal of proposals) {
    const key = proposal.kind === "transaction_create" ? `${proposal.title}|${proposal.detail}` : proposal.id;
    groups.set(key, [...(groups.get(key) ?? []), proposal]);
  }
  return [...groups.values()];
}

function RepeatGroup({ proposals, locale }: { proposals: OpenProposal[]; locale?: string }) {
  const [pending, start] = useBusy();
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string>();
  if (dismissed) return <p role="status" className="my-3 text-sm text-muted-foreground">Dismissed {proposals.length} repeats. Nothing was changed.</p>;
  const dismiss = () => start(async () => {
    setError(undefined);
    try {
      const outcomes = await decideAgentProposals(proposals.map(proposal => proposal.id), "reject");
      const failed = outcomes.find(outcome => outcome.error);
      if (failed) setError(failed.error); else setDismissed(true);
    } catch { setError("Could not dismiss these. Try again."); }
  });
  return <details aria-label="Similar proposals" className="my-3 rounded-xl border border-ai-border bg-ai-soft/40 p-4">
    <summary className="cursor-pointer font-medium">{proposals.length} similar: {proposals[0].title}</summary>
    <p className="mt-2 text-sm text-muted-foreground">These look like the same purchase. Add only the ones that really happened.</p>
    {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    <button type="button" disabled={pending} onClick={dismiss} className="mt-2 min-h-9 rounded-lg border border-border px-4 text-sm hover:bg-muted disabled:opacity-50">Dismiss all {proposals.length}</button>
    {proposals.map(proposal => <IouCard key={proposal.id} id={proposal.id} initial={proposal} locale={locale} />)}
  </details>;
}

/**
 * What waits for a decision: loans, expenses and balances as single cards; recurring, uncategorized and flagged items as one
 * summary card each that opens them in a sheet. Filtered-out cards stay mounted (hidden), so a card decided here keeps its outcome.
 */
export function WaitingForYouList({ proposals: all, review = { uncategorized: 0, findings: [] }, locale }: { proposals: OpenProposal[]; review?: HomeReview; locale?: string }) {
  const [filter, setFilter] = useState<Filter>();
  const [expanded, setExpanded] = useState(false);
  const recurring = all.filter(proposal => proposal.kind === "recurring_edit");
  const proposals = all.filter(proposal => proposal.kind !== "recurring_edit");
  const entries: { key: string; filter?: Filter; node: React.ReactNode }[] = [
    ...review.uncategorized > 0 ? [{ key: "uncategorized", node: <SummaryCard title={`${plural(review.uncategorized, "transaction needs", "transactions need")} a category`} detail="Grouped by merchant, with a suggestion where the app has one."><UncategorizedSheet total={review.uncategorized} locale={locale} /></SummaryCard> }] : [],
    ...recurring.length > 0 ? [{ key: "recurring", node: <SummaryCard title={`${plural(recurring.length, "recurring change", "recurring changes")} to confirm`} detail="Payments that repeat, and price changes on ones you confirmed."><RecurringSheet proposals={recurring} /></SummaryCard> }] : [],
    ...review.findings.length > 0 ? [{ key: "findings", node: <SummaryCard title={`${plural(review.findings.length, "thing looks", "things look")} off`} detail="Possible duplicates, fees and unusual charges from your latest syncs."><FindingsSheet findings={review.findings} locale={locale} /></SummaryCard> }] : [],
    ...groupRepeats(proposals).map(group => ({ key: group[0].id, filter: filterOf(group[0].kind), node: group.length === 1 ? <IouCard id={group[0].id} initial={group[0]} locale={locale} /> : <RepeatGroup proposals={group} locale={locale} /> })),
  ];
  const count = filter ? entries.filter(entry => entry.filter === filter).length : entries.length;
  const present = FILTERS.filter(([key]) => proposals.some(proposal => filterOf(proposal.kind) === key));
  const chip = (active: boolean) => `h-11 rounded-full border px-3.5 lg:h-9 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ai ${active ? "border-foreground bg-foreground text-background" : "border-input text-muted-foreground hover:bg-muted hover:text-foreground"}`;
  return <details open aria-label="Waiting for you" className="group">
    <summary className="-mx-1 flex min-h-11 cursor-pointer list-none items-center gap-2.5 rounded-lg px-1 focus-visible:outline-2 focus-visible:outline-ai [&::-webkit-details-marker]:hidden">
      <span className="font-display text-lg font-semibold">Waiting for you</span>
      <span className="rounded-full bg-ai-soft px-2 py-0.5 text-xs font-medium text-ai tabular-nums">{count}<span className="sr-only"> {count === 1 ? "decision" : "decisions"}</span></span>
      <ChevronDown className="ml-auto size-4 text-muted-foreground transition-transform group-not-open:-rotate-90" aria-hidden="true" />
    </summary>
    {present.length > 1 && <div role="group" aria-label="Show" className="mt-2 flex flex-wrap gap-1.5">
      <button type="button" aria-pressed={!filter} onClick={() => setFilter(undefined)} className={chip(!filter)}>All</button>
      {present.map(([key, label]) => <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)} className={chip(filter === key)}>{label}</button>)}
    </div>}
    {entries.map((entry, index) => <div key={entry.key} hidden={filter ? entry.filter !== filter : !expanded && index >= VISIBLE}>{entry.node}</div>)}
    {!filter && entries.length > VISIBLE && <button type="button" aria-expanded={expanded} onClick={() => setExpanded(open => !open)} className="mt-1 min-h-11 text-sm font-medium text-ai underline-offset-2 hover:underline lg:min-h-9">{expanded ? "Show fewer" : `View all ${entries.length}`}</button>}
  </details>;
}

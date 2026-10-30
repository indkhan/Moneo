"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { IouCard } from "@/components/iou-card";
import { decideAgentProposals } from "@/app/ai/agents/actions";
import { formatMoney } from "@/lib/finance/format";
import { confirmRecurringCard, loadRecurringCards } from "./actions";
import { ScheduleDialog } from "./forms";

type Card = { id: string; title: string; detail: string; conflict_key?: string };
type Loaded = Awaited<ReturnType<typeof loadRecurringCards>>;

const primary = "min-h-9 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50";
const secondary = "min-h-9 rounded-lg border border-border px-4 text-sm hover:bg-muted disabled:opacity-50";
const detected = (card: Card) => /^recurring_(new|price):/.test(card.conflict_key ?? "");

/**
 * Recurring patterns detection raised. Each card shows the payments behind it, and saying yes always opens the dialog
 * to check the amount, next date and category first, so a payment whose price or day moved is saved as it really is.
 */
export function RecurringCards({ cards }: { cards: Card[] }) {
  const [loaded, setLoaded] = useState<Loaded>();
  const ids = cards.filter(detected).map(card => card.id).join(",");
  useEffect(() => {
    if (!ids) return;
    loadRecurringCards(ids.split(",")).then(setLoaded, () => setLoaded({ details: {}, categories: [], locale: undefined }));
  }, [ids]);
  return <div>{cards.map(card => detected(card)
    ? <RecurringCard key={card.id} card={card} loaded={loaded} />
    : <IouCard key={card.id} id={card.id} initial={{ ...card, status: "proposed", kind: "recurring_edit" }} />)}</div>;
}

function RecurringCard({ card, loaded }: { card: Card; loaded?: Loaded }) {
  const [outcome, setOutcome] = useState<"saved" | "dismissed">();
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  const price = card.conflict_key?.startsWith("recurring_price:");
  const details = loaded?.details[card.id];
  const money = (minor: string, currency: string) => formatMoney(minor, currency, loaded?.locale);
  const dismiss = () => start(async () => {
    setError(undefined);
    try {
      const [result] = await decideAgentProposals([card.id], "reject");
      if (result?.error) setError(result.error); else setOutcome("dismissed");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save"); }
  });
  return <section aria-label="Recurring proposal" className="my-3 rounded-xl border border-ai-border bg-ai-soft p-4">
    <p className="font-medium">{card.title}</p>
    {/* A new pattern's stored detail predates the dialog; its payments below say more. */}
    {price && card.detail && !outcome && <p className="mt-1 text-sm text-muted-foreground">{card.detail}</p>}
    {outcome ? <p role="status" className="mt-2 text-sm">{outcome === "saved" ? <>Saved. <Link href="/money/recurring" className="underline">See it on Recurring</Link></>
      : price ? "Kept the current amount." : "Dismissed. It won’t be suggested again."}</p> : <>
      {details && <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Show the {details.transactions.length} payments behind this</summary>
        <ul className="mt-2 divide-y divide-border rounded-lg border border-border bg-background">{details.transactions.map(row =>
          <li key={row.id}><Link href={`/money/transactions?transaction=${row.id}`} className="flex items-baseline gap-3 px-3 py-2 hover:bg-muted">
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{row.date}</span>
            <span className="min-w-0 flex-1 truncate">{row.description}</span>
            <span className="shrink-0 font-mono">{money(row.amountMinor, details.currencyCode)}</span></Link></li>)}</ul>
      </details>}
      {loaded && details === null && <p className="mt-2 text-sm text-muted-foreground">Its payments changed since it was found. <Link href="/money/recurring" className="underline">Review it on Recurring</Link>, or dismiss it.</p>}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {details ? <ScheduleDialog title={price ? `Update ${details.name}` : `Confirm ${details.name}`} trigger={price ? "Update amount" : "Yes, recurring"} triggerClassName={primary}
          submitLabel={price ? "Save" : "Confirm recurring"} action={confirmRecurringCard} hidden={{ proposalId: card.id }} categories={loaded?.categories ?? []}
          defaults={details} onDone={() => setOutcome("saved")} />
          : <button type="button" disabled className={primary}>{loaded ? (price ? "Update amount" : "Yes, recurring") : "Loading…"}</button>}
        <button type="button" disabled={pending} onClick={dismiss} className={secondary}>{price ? "Keep current amount" : "Not recurring"}</button>
      </div>
    </>}
  </section>;
}

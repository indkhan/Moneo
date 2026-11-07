"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { decideAgentProposals } from "@/app/ai/agents/actions";
import type { ChatProposal } from "@/app/ai/iou-actions";
import { useBusy } from "@/components/use-busy";
import { displayFormat } from "@/lib/display-format";
import type { TradeReview } from "@/lib/scalable/orders";

type Proposal = Pick<ChatProposal, "id" | "title" | "detail" | "status"> & Partial<ChatProposal> & { trade: TradeReview };

/** Seconds left on Scalable's preview, ticking once a second; null for cards without one. */
function useSecondsLeft(expiresAt: string | null) {
  const left = () => expiresAt ? Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000)) : null;
  const [seconds, setSeconds] = useState(left);
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setInterval(() => setSeconds(left()), 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt]);
  return seconds;
}

/**
 * A Scalable order (or order cancellation) waiting for the owner's tap. The figures are Scalable's own preview;
 * tapping Buy, Sell or Cancel order is the only thing that sends it, and each card is confirmed on its own.
 */
export function TradeCard({ id, proposal, locale = "en-GB", onChange }: { id: string; proposal: Proposal; locale?: string; onChange: (next: Proposal) => void }) {
  const [error, setError] = useState<string>();
  const [pending, start] = useBusy();
  const { trade } = proposal;
  const seconds = useSecondsLeft(trade.expiresAt);
  const { money, dateTime } = displayFormat(locale, Intl.DateTimeFormat().resolvedOptions().timeZone);
  const amount = (minor: string | null) => minor === null ? "—" : money(minor, trade.currencyCode);
  const expired = seconds === 0;
  const open = proposal.status === "proposed" || proposal.status === "failed";
  const verb = trade.action === "buy" ? "Buy" : trade.action === "sell" ? "Sell" : "Cancel order";
  const decide = (decision: "accept" | "reject") => start(async () => {
    setError(undefined);
    try {
      const [outcome] = await decideAgentProposals([id], decision);
      if (outcome.status === "unknown") onChange({ ...proposal, status: "applying", result: { error: outcome.error, unknown: true } });
      else if (outcome.error) { setError(outcome.error); onChange({ ...proposal, status: "failed" }); }
      else onChange({ ...proposal, status: decision === "accept" ? "accepted" : "rejected" });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not reach Moneo. Nothing was sent."); }
  });
  const tone = trade.action === "buy" ? "bg-success-soft text-success" : trade.action === "sell" ? "bg-danger-soft text-danger" : "bg-muted text-foreground";
  const clock = seconds === null ? null : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const figures: [string, string][] = trade.action === "cancel"
    ? [["Shares", trade.shares ?? "—"], ["Limit", amount(trade.limitPriceMinor)], ["Status", (trade.status ?? "").toLowerCase() || "—"]]
    : [["Shares", trade.shares ?? "—"], [trade.orderType === "limit" ? "Limit price" : "Price", amount(trade.orderType === "limit" ? trade.limitPriceMinor : trade.estimatePriceMinor)],
      ["Estimated total", amount(trade.estimatedTotalMinor)], ["Order cost", amount(trade.entryCostMinor)]];

  return <section aria-label={`${verb} card`} className="my-3 rounded-xl border border-ai-border bg-ai-soft p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${tone}`}>{trade.action === "cancel" ? "Cancel order" : `${verb} · ${trade.orderType === "limit" ? "limit" : "market"}`}</span>
      {open && clock !== null && <span role="timer" aria-live="off" className={`font-mono text-xs tabular-nums ${expired ? "text-danger" : seconds! < 60 ? "text-warning" : "text-muted-foreground"}`}>{expired ? "Preview expired" : `Valid for ${clock}`}</span>}
    </div>
    <p className="mt-2 font-medium">{trade.name}</p>
    {trade.isin && <p className="font-mono text-xs text-muted-foreground">{trade.isin}{trade.venue ? ` · ${trade.venue}` : ""}</p>}
    <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">{figures.map(([label, value]) =>
      <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="font-mono tabular-nums">{value}</dd></div>)}</dl>
    {trade.quote && <p className="mt-2 text-xs text-muted-foreground">Bid {amount(trade.quote.bidMinor)} · ask {amount(trade.quote.askMinor)}{trade.quote.at ? ` · quoted ${dateTime(trade.quote.at)}` : ""}{trade.quote.outdated ? " · market closed, the price can differ when it opens" : ""}</p>}
    {trade.wholePosition && <p className="mt-2 text-sm text-warning">This sells your whole position.</p>}
    {trade.warnings.length > 0 && <ul className="mt-2 space-y-1 text-sm text-warning">{trade.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
    {trade.review && <details className="mt-3 text-sm"><summary className="cursor-pointer text-muted-foreground hover:text-foreground">Scalable&apos;s full review</summary>
      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-background p-3 font-sans text-xs">{trade.review}</pre>
      {trade.kid && <a href={trade.kid.url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-brand underline">{trade.kid.label}</a>}
    </details>}
    {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    {open ? <div className="mt-3 flex flex-wrap items-center gap-2">
      <button type="button" aria-label={`${verb}: ${proposal.title}`} disabled={pending || expired} onClick={() => decide("accept")}
        className="min-h-9 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">{pending ? "Sending…" : verb}</button>
      <button type="button" aria-label={`Dismiss: ${proposal.title}`} disabled={pending} onClick={() => decide("reject")} className="min-h-9 rounded-lg border border-border px-4 text-sm hover:bg-muted disabled:opacity-50">Dismiss</button>
      {trade.brokerUrl && <a href={trade.brokerUrl} target="_blank" rel="noreferrer" className="min-h-9 content-center px-1 text-sm text-muted-foreground underline hover:text-foreground">Open in Scalable</a>}
      {expired && <p className="w-full text-sm text-muted-foreground">Ask again for a fresh preview; nothing was sent.</p>}
    </div> : <p role="status" className="mt-2 text-sm">{proposal.status === "accepted"
      ? <>{trade.action === "cancel" ? "Cancellation sent to Scalable." : "Order sent to Scalable."}{proposal.result?.reference ? ` Reference ${proposal.result.reference}.` : ""} <Link href="/money/wealth" className="underline">Wealth</Link> shows it after the next sync.</>
      : proposal.status === "applying" ? <span className="text-warning">{proposal.result?.unknown ? proposal.result.error : "Sending to Scalable…"}</span>
      : "Dismissed. Nothing was sent."}</p>}
  </section>;
}

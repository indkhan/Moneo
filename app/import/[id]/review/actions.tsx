"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// fetch rejects only when the request never completed, so nothing was saved.
const failureMessage = (cause: unknown) => cause instanceof TypeError ? "Could not reach Moneo. Check your connection and try again; your choices are still here." : cause instanceof Error ? cause.message : "Review failed";
// A decided card disappears on refresh, so keyboard focus moves to the updated progress summary.
const focusProgress = () => document.getElementById("review-progress")?.focus();

export function ReviewActions({ importId, sourceId, rowNumber, frozenId = null, frozenName, unavailable = false, destinations = [] }: {
  importId: string; sourceId: string; rowNumber: number; frozenId?: string | null; frozenName?: string; unavailable?: boolean;
  destinations?: { id: string; name: string; currency_code: string; version: number }[];
}) {
  const router = useRouter();
  const [destinationId, setDestinationId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function decide(action: "accept" | "reject") {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/imports/${importId}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId, action, ...(destinationId && action === "accept" ? {
          accountId: destinationId, expectedRouteId: frozenId,
          expectedAccountVersion: destinations.find(account => account.id === destinationId)?.version,
        } : {}) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Review failed");
      router.refresh();
      focusProgress();
    } catch (cause) {
      setError(failureMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return <div className="flex flex-wrap items-center gap-3">
    {frozenName && <p className="w-full text-sm text-muted-foreground">Planned account: {frozenName}</p>}
    {unavailable && <p className="w-full text-sm text-muted-foreground">The planned account is unavailable. Pick an active account in the same currency to accept this row.</p>}
    {!!destinations.length && <label className="flex w-full min-w-0 flex-wrap items-center gap-2 text-sm font-medium">Account for this row
      <select className="min-h-10 w-full min-w-0 rounded-lg sm:w-auto sm:max-w-md border border-border bg-card px-3 py-2 text-sm font-normal" value={destinationId} onChange={event => setDestinationId(event.target.value)} disabled={busy}>
        <option value="">{unavailable ? "Choose an account" : "Keep planned account"}</option>
        {destinations.map(account => <option key={account.id} value={account.id}>{account.name} ({account.currency_code})</option>)}
      </select>
    </label>}
    <button className="min-h-10 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50" type="button" aria-label={`Accept as new, row ${rowNumber}`} disabled={busy || (unavailable && !destinationId)} onClick={() => void decide("accept")}>Accept as new</button>
    <button className="min-h-10 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted" type="button" aria-label={`Reject, row ${rowNumber}`} disabled={busy} onClick={() => void decide("reject")}>Reject</button>
    <p className="w-full text-xs text-muted-foreground">Reject leaves this row out of your totals and keeps the original. Undo decision in Decided rows puts this row back in review. Accepted rows can be reopened only while their transaction and balance evidence have no later changes or dependencies.</p>
    {error && <p role="alert" className="w-full text-sm text-danger">{error}</p>}
  </div>;
}

export function ClassificationActions({ importId, transactionId, version, reasons, eventId, name }: {
  importId: string; transactionId: string; version: number; reasons?: string[]; eventId?: string; name: string;
}) {
  const router = useRouter();
  const [kind, setKind] = useState("ordinary");
  const [feeIncluded, setFeeIncluded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/imports/${importId}/classification`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(eventId ? { action: "undo", transactionId, version, eventId } : { action: "review", transactionId, version, kind, feeIncluded }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Review failed");
      router.refresh();
      focusProgress();
    } catch (cause) { setError(failureMessage(cause)); }
    finally { setBusy(false); }
  }
  return <div className="space-y-4 text-sm">
    {!eventId && <>
      <label className="grid gap-1.5 font-medium">Transaction type<select className="min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm font-normal" value={kind} onChange={event => setKind(event.target.value)}>
        <option value="ordinary">Income or expense (not an internal movement)</option><option value="refund">Refund</option><option value="transfer">Internal transfer (link both legs first)</option>
      </select></label>
      {reasons?.includes("fee_semantics") && <label className="flex items-start gap-2"><input type="checkbox" checked={feeIncluded} onChange={event => setFeeIncluded(event.target.checked)} />The booked amount already includes the fee, so no extra fee transaction is needed.</label>}
      <p className="text-muted-foreground">Unknown or separate fees stay under review. <a className="underline" href={`/money/transactions?transaction=${transactionId}`}>Open the transaction to link or inspect it</a></p>
    </>}
    <button type="button" className="min-h-10 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50" aria-label={`${eventId ? "Undo classification review" : "Confirm type"} for ${name}`} disabled={busy} onClick={() => void submit()}>{eventId ? "Undo classification review" : "Confirm type"}</button>
    {error && <p role="alert" className="text-danger">{error}</p>}
  </div>;
}

/** Undo names the exact receipt, so an old tab cannot reopen a newer decision. */
export function UndoRowDecision({ importId, sourceId, decisionId, rowNumber }: { importId: string; sourceId: string; decisionId: string; rowNumber: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  async function undo() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/imports/${importId}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceId, action: "undo", decisionId }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Review failed");
      router.refresh(); focusProgress();
    } catch (cause) { setError(failureMessage(cause)); }
    finally { setBusy(false); }
  }
  return <div className="space-y-2">
    {confirm ? <><p>This returns row {rowNumber} to review. Its accepted transaction and source balance, if any, leave your totals. Other rows stay as they are. The original and decision history are kept.</p>
      <div className="flex gap-3"><button type="button" disabled={busy} onClick={() => void undo()} className="min-h-11 rounded-lg border border-border px-3">{busy ? "Reopening..." : "Confirm undo decision"}</button><button type="button" disabled={busy} onClick={() => setConfirm(false)} className="min-h-11 px-3 underline">Cancel</button></div></>
      : <button type="button" aria-label={`Undo decision, row ${rowNumber}`} onClick={() => setConfirm(true)} className="min-h-11 underline">Undo decision</button>}
    {error && <p role="alert" className="text-danger">{error}</p>}
  </div>;
}

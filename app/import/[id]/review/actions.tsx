"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ReviewActions({ importId, sourceId, frozenId = null, frozenName, unavailable = false, destinations = [] }: {
  importId: string; sourceId: string; frozenId?: string | null; frozenName?: string; unavailable?: boolean;
  destinations?: { id: string; name: string; version: number }[];
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Review failed");
    } finally {
      setBusy(false);
    }
  }

  return <div className="flex flex-wrap items-center gap-3">
    {frozenName && <p className="w-full text-sm text-muted-foreground">Planned account: {frozenName}</p>}
    {unavailable && <p className="w-full text-sm text-muted-foreground">The planned account is unavailable. Pick an active account in the same currency to accept this row.</p>}
    {!!destinations.length && <label className="flex w-full flex-wrap items-center gap-2 text-sm font-medium">Reviewed destination
      <select className="min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm font-normal" value={destinationId} onChange={event => setDestinationId(event.target.value)} disabled={busy}>
        <option value="">{unavailable ? "Choose an account" : "Keep planned account"}</option>
        {destinations.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
      </select>
    </label>}
    <button className="min-h-10 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50" type="button" disabled={busy || (unavailable && !destinationId)} onClick={() => void decide("accept")}>Accept as new</button>
    <button className="min-h-10 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted" type="button" disabled={busy} onClick={() => void decide("reject")}>Reject</button>
    {error && <p role="alert" className="w-full text-sm text-red-700 dark:text-red-300">{error}</p>}
  </div>;
}

export function ClassificationActions({ importId, transactionId, version, reasons, eventId }: {
  importId: string; transactionId: string; version: number; reasons?: string[]; eventId?: string;
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
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Review failed"); }
    finally { setBusy(false); }
  }
  return <div className="space-y-4 text-sm">
    {!eventId && <>
      <label className="grid gap-1.5 font-medium">Reviewed financial meaning<select className="min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm font-normal" value={kind} onChange={event => setKind(event.target.value)}>
        <option value="ordinary">Income or expense (not an internal movement)</option><option value="refund">Refund</option><option value="transfer">Internal transfer (link both legs first)</option>
      </select></label>
      {reasons?.includes("fee_semantics") && <label className="flex items-start gap-2"><input type="checkbox" checked={feeIncluded} onChange={event => setFeeIncluded(event.target.checked)} />The booked amount already includes the fee, so no extra fee transaction is needed.</label>}
      <p className="text-muted-foreground">Unknown or separate fees stay under review. <a className="underline" href={`/money/transactions?transaction=${transactionId}`}>Open the transaction to link or inspect it</a></p>
    </>}
    <button type="button" className="min-h-10 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50" disabled={busy} onClick={() => void submit()}>{eventId ? "Undo classification review" : "Confirm reviewed meaning"}</button>
    {error && <p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}
  </div>;
}

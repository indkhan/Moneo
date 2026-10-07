"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatInputAmount, formatMoney } from "@/lib/finance/format";
import { pendingSettlementSchema, type PendingResolution } from "@/lib/finance/pending-holds";
import { parseManualAmount } from "./input";

export type PendingPosting = { id: string; version: number; description: string; posted_on: string; amount_minor: string };
export function PendingHoldEditor({ pending, currency, releasedMinor, postings = [], resolutions = [], importId, sourceId }: {
  pending: PendingPosting; currency: string; releasedMinor: string; postings?: PendingPosting[]; resolutions?: PendingResolution[];
  importId?: string; sourceId?: string;
}) {
  const router = useRouter();
  const outstanding = -BigInt(pending.amount_minor) - BigInt(releasedMinor);
  const [postedId, setPostedId] = useState("");
  const [amount, setAmount] = useState(formatInputAmount(outstanding, currency));
  const [note, setNote] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(resolutionId?: string) {
    setBusy(true); setError("");
    try {
      const settlement = resolutionId ? null : pendingSettlementSchema.parse({ pendingId: pending.id, pendingVersion: pending.version,
        expectedReleasedMinor: releasedMinor, releasedMinor: parseManualAmount(amount, currency).toString(), note, requestId });
      const posting = postings.find(row => row.id === postedId);
      const url = sourceId && !resolutionId ? `/api/imports/${importId}/review` : "/api/pending-holds";
      const body = resolutionId ? { action: "undo", resolutionId } : sourceId ? { sourceId, action: "accept", settlement }
        : { ...settlement, action: "resolve", postedId: posting?.id ?? null, postedVersion: posting?.version ?? null };
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Pending resolution failed");
      setRequestId(crypto.randomUUID()); router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Pending resolution failed"); }
    finally { setBusy(false); }
  }
  return <section aria-label="Pending hold resolution" className="mt-4 space-y-3 rounded border border-border p-3 text-sm">
    <h3 className="font-medium">Pending hold: {pending.description}</h3>
    <p>{pending.posted_on} · Original {formatMoney(pending.amount_minor, currency)} · Outstanding {formatMoney(outstanding, currency)}</p>
    {outstanding > 0n && <>
      {!sourceId && <label className="grid gap-1">Settlement evidence<select value={postedId} onChange={event => setPostedId(event.target.value)} disabled={busy} className="rounded border bg-card p-2">
        <option value="">Cancel hold (no posted payment)</option>
        {postings.map(row => <option key={row.id} value={row.id}>{row.posted_on} · {row.description} · {formatMoney(row.amount_minor, currency)}</option>)}
      </select></label>}
      <p>The released authorization can differ from the booked payment. For a partial capture, release only the confirmed portion. Both source records remain unchanged.</p>
      <label className="grid gap-1">Hold amount to release ({currency})<input aria-label="Hold amount to release" value={amount} onChange={event => setAmount(event.target.value)} inputMode="decimal" disabled={busy} className="rounded border bg-card p-2" /></label>
      <label className="grid gap-1">Reviewed evidence / reason<input value={note} onChange={event => setNote(event.target.value)} maxLength={500} disabled={busy} className="rounded border bg-card p-2" /></label>
      <button type="button" disabled={busy || !note.trim()} onClick={() => void submit()} className="rounded bg-brand px-3 py-2 text-white">{sourceId ? "Accept settlement and release hold" : postedId ? "Confirm settlement and release hold" : "Confirm cancellation and release hold"}</button>
    </>}
    {resolutions.map(row => <div key={row.id} className="border-t pt-2"><p>{row.operation === "settle" ? "Settlement" : "Cancellation"} · {formatMoney(row.released_minor, currency)} · {row.note}{row.undone_at ? " · undone" : ""}</p>
      {!row.undone_at && <button type="button" className="underline" disabled={busy} onClick={() => void submit(row.id)}>Undo hold resolution</button>}
    </div>)}
    {error && <p role="alert">{error}</p>}
  </section>;
}

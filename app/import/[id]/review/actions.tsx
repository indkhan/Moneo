"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ReviewActions({ importId, sourceId }: { importId: string; sourceId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function decide(action: "accept" | "reject") {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/imports/${importId}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId, action }),
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

  return <div className="mt-3 flex flex-wrap gap-3">
    <button className="rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white hover:opacity-90" type="button" disabled={busy} onClick={() => void decide("accept")}>Accept as new</button>
    <button className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-muted" type="button" disabled={busy} onClick={() => void decide("reject")}>Reject</button>
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
  return <div className="mt-3 space-y-3 text-sm">
    {!eventId && <>
      <label className="grid gap-1">Reviewed financial meaning<select className="rounded-lg border border-border bg-card p-2" value={kind} onChange={event => setKind(event.target.value)}>
        <option value="ordinary">Income or expense (not an internal movement)</option><option value="refund">Refund</option><option value="transfer">Internal transfer (link both legs first)</option>
      </select></label>
      {reasons?.includes("fee_semantics") && <label className="flex items-start gap-2"><input type="checkbox" checked={feeIncluded} onChange={event => setFeeIncluded(event.target.checked)} />I verified the booked amount already includes the source fee. No extra fee transaction is needed.</label>}
      <p className="text-muted-foreground">Unknown or separate fees must remain under review. <a className="underline" href={`/money/transactions?transaction=${transactionId}`}>Open transaction to link or inspect evidence</a></p>
    </>}
    <button type="button" className="rounded-lg bg-brand px-3 py-2 text-white" disabled={busy} onClick={() => void submit()}>{eventId ? "Undo classification review" : "Confirm reviewed meaning"}</button>
    {error && <p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}
  </div>;
}

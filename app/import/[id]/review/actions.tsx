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
    {error && <p role="alert" className="w-full text-sm text-red-700">{error}</p>}
  </div>;
}

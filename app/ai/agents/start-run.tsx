"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Play } from "lucide-react";

export function StartAgentRun({ label = "Run agent team", className }: { label?: string; className?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();
  async function start() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/agents/runs", { method: "POST" });
      const body = await response.json();
      if (!response.ok || !body.runId) throw new Error(body.error ?? "The agent team could not start");
      router.push(`/ai/agents/${body.runId}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The agent team could not start"); setBusy(false); }
  }
  return <span className="inline-flex flex-col items-end gap-1">
    <button type="button" disabled={busy} onClick={() => void start()} className={className ?? "inline-flex h-11 items-center gap-2 rounded-xl bg-ai px-4 text-[13px] font-medium text-[#0f1011] hover:opacity-90 disabled:opacity-50"}><Play className="size-3.5" aria-hidden="true" />{busy ? "Starting…" : label}</button>
    {error && <span role="alert" className="text-xs text-danger">{error}</span>}
  </span>;
}

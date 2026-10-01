"use client";

import { useRef, useState } from "react";

export function useChatRequest() {
  const active = useRef<{ requestId: string; controller: AbortController } | null>(null);
  const [status, setStatus] = useState<"idle" | "running" | "completed" | "failed" | "canceled">("idle");
  const [error, setError] = useState("");

  async function send(payload: { conversationId: string; message: string; context?: Record<string, unknown> }) {
    if (active.current) return null;
    const run = { requestId: crypto.randomUUID(), controller: new AbortController() };
    active.current = run;
    setStatus("running");
    setError("");
    try {
      const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
        signal: run.controller.signal, body: JSON.stringify({ ...payload, requestId: run.requestId }) });
      const result = await response.json();
      if (active.current !== run) return null;
      if (!response.ok) throw new Error(result.error ?? "Could not answer");
      setStatus("completed");
      return result as { answer: string; conversationId: string };
    } catch (cause) {
      if (active.current === run) { setStatus("failed"); setError(cause instanceof Error ? cause.message : "Could not answer"); }
      return null;
    } finally { if (active.current === run) active.current = null; }
  }

  async function cancel() {
    const run = active.current;
    if (!run) return;
    try {
      let response: Response | undefined;
      // Cancellation can arrive before the server has claimed this request.
      for (let attempt = 0; attempt < 10; attempt++) {
        response = await fetch("/api/chat", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: run.requestId }) });
        if (response.status !== 404) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const result = await response!.json();
      if (!response!.ok) throw new Error(result.error ?? "Could not cancel; try again");
      if (result.status === "canceled" && active.current === run) {
        active.current = null;
        run.controller.abort();
        setStatus("canceled");
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not cancel; try again"); }
  }

  return { send, cancel, status, error, busy: status === "running" };
}

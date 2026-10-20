"use client";

import { useRef, useState } from "react";
import type { FollowUp } from "./follow-ups";

export type ChatAnswer = { answer: string; conversationId: string; toolsUsed?: string[]; followUps?: FollowUp[] };
export type ChatStreamEvent =
  | { type: "started" }
  | { type: "tool"; id?: string; name: string; state: "running" | "done" | "failed"; input?: unknown; output?: string }
  | { type: "plan"; steps: string[] }
  | ({ type: "answer" } & ChatAnswer)
  | { type: "result"; status: number; body: unknown };

/** Reads the opt-in NDJSON stream, or a plain JSON response, into the final status and body. */
async function readResponse(response: Response, onEvent: (event: ChatStreamEvent) => void): Promise<{ ok: boolean; body: { error?: string } & Partial<ChatAnswer> }> {
  if (!response.headers.get("content-type")?.includes("application/x-ndjson") || !response.body) return { ok: response.ok, body: await response.json() };
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += value ?? "";
    const lines = buffer.split("\n");
    buffer = done ? "" : lines.pop()!;
    for (const line of lines.filter(Boolean)) {
      const event = JSON.parse(line) as ChatStreamEvent;
      if (event.type === "result") return { ok: event.status < 400, body: event.body as { error?: string } };
      onEvent(event);
    }
    if (done) throw new Error("The answer stream ended early; reload to see whether it was saved");
  }
}

export function useChatRequest() {
  const active = useRef<{ requestId: string; controller: AbortController } | null>(null);
  const [status, setStatus] = useState<"idle" | "running" | "completed" | "failed" | "canceled">("idle");
  const [error, setError] = useState("");

  async function send(payload: { conversationId: string; message: string; context?: Record<string, unknown> }, onEvent?: (event: ChatStreamEvent) => void) {
    if (active.current) return null;
    const run = { requestId: crypto.randomUUID(), controller: new AbortController() };
    active.current = run;
    setStatus("running");
    setError("");
    try {
      const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/x-ndjson, application/json" },
        signal: run.controller.signal, body: JSON.stringify({ ...payload, requestId: run.requestId }) });
      // Events from a canceled run are never shown.
      const result = await readResponse(response, event => { if (active.current === run) onEvent?.(event); });
      if (active.current !== run) return null;
      if (!result.ok) throw new Error(result.body.error ?? "Could not answer");
      setStatus("completed");
      return result.body as ChatAnswer;
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

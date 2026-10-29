"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { VoiceInput } from "@/components/voice-input";
import { withSpoken } from "@/components/chat-composer";

/** Builds a new artifact, or a new version of one; the AI can take a minute or two. */
export function ArtifactPrompt({ artifactId, defaultValue = "", placeholder }: { artifactId?: string; defaultValue?: string; placeholder: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();
  const input = useRef<HTMLTextAreaElement>(null);
  // Spoken words join what is typed; Send then submits the request as typed words would.
  function speak(text: string, submit: boolean) {
    const field = input.current;
    if (!field) return;
    field.value = withSpoken(field.value, text).slice(0, 4000);
    if (submit) field.form?.requestSubmit(); else field.focus();
  }
  async function submit(form: HTMLFormElement) {
    const message = String(new FormData(form).get("message") ?? "").trim();
    if (!message) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/artifacts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ artifactId, message }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.id) throw new Error(body.error ?? "Could not build the artifact");
      form.reset();
      router.push(`/ai/artifacts/${body.id}`);
      router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not build the artifact"); }
    finally { setBusy(false); }
  }
  return <form onSubmit={event => { event.preventDefault(); void submit(event.currentTarget); }} className="relative grid gap-2">
    <textarea ref={input} name="message" required maxLength={4000} rows={artifactId ? 3 : 4} defaultValue={defaultValue} placeholder={placeholder} disabled={busy} aria-label={placeholder}
      onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit(); }}
      className="w-full resize-y rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
    <div className="flex items-center justify-between gap-2">
      {error ? <span role="alert" className="text-xs text-danger">{error}</span> : <span className="text-xs text-muted-foreground">{busy ? "Building… this can take a minute." : "Uses your real data, read-only."}</span>}
      <span className="flex items-center gap-1.5"><VoiceInput disabled={busy} onSend={text => speak(text, true)} onDone={text => speak(text, false)} />
      <button type="submit" disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
        <Sparkles className="size-3.5" aria-hidden="true" />{busy ? "Building…" : artifactId ? "Update" : "Build"}</button></span>
    </div>
  </form>;
}

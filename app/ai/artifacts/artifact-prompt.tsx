"use client";

import { useRef } from "react";
import { Sparkles } from "lucide-react";
import { VoiceInput } from "@/components/voice-input";
import { withSpoken } from "@/components/chat-composer";
import { SafeForm } from "@/components/safe-form";
import { createArtifactSafely } from "./actions";

/** Starts a new artifact: it opens in its own chat, where the build streams and keeps going if the tab closes. */
export function ArtifactPrompt({ defaultValue = "", placeholder }: { defaultValue?: string; placeholder: string }) {
  const input = useRef<HTMLTextAreaElement>(null);
  // Spoken words join what is typed; Send then submits the request as typed words would.
  function speak(text: string, submit: boolean) {
    const field = input.current;
    if (!field) return;
    field.value = withSpoken(field.value, text).slice(0, 4000);
    if (submit) field.form?.requestSubmit(); else field.focus();
  }
  return <SafeForm action={createArtifactSafely} className="relative grid gap-2">
    <textarea ref={input} name="prompt" required maxLength={4000} rows={4} defaultValue={defaultValue} placeholder={placeholder} aria-label={placeholder}
      onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit(); }}
      className="w-full resize-y rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">Uses an AI request and your real data, read-only.</span>
      <span className="flex items-center gap-1.5"><VoiceInput onSend={text => speak(text, true)} onDone={text => speak(text, false)} /><button type="submit" className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"><Sparkles className="size-3.5" aria-hidden="true" />Build</button></span>
    </div>
  </SafeForm>;
}

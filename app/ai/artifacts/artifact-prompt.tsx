"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { VoiceInput } from "@/components/voice-input";
import { withSpoken } from "@/components/chat-composer";
import { SafeForm } from "@/components/safe-form";
import { createArtifactSafely } from "./actions";

const EXAMPLE_EVENT = "moneo-artifact-example";

/** Fills the prompt on this page; nothing runs until Build. */
export function ArtifactExamples({ examples }: { examples: readonly { title: string; summary: string; prompt: string }[] }) {
  return <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{examples.map(example => <li key={example.title}>
    <button type="button" onClick={() => window.dispatchEvent(new CustomEvent(EXAMPLE_EVENT, { detail: example.prompt }))} className="block h-full w-full rounded-xl border border-border bg-card p-4 text-left hover:bg-muted">
      <span className="block font-medium">{example.title}</span>
      <span className="mt-1 block text-xs text-muted-foreground">{example.summary}</span>
    </button></li>)}</ul>;
}

/** Starts a new artifact: it opens in its own chat, where the build streams and keeps going if the tab closes. */
export function ArtifactPrompt({ defaultValue = "", placeholder }: { defaultValue?: string; placeholder: string }) {
  const input = useRef<HTMLTextAreaElement>(null);
  // What the first example replaced, so choosing one never loses a draft.
  const [replaced, setReplaced] = useState("");
  const lastExample = useRef("");
  useEffect(() => {
    const use = (event: Event) => {
      const field = input.current;
      if (!field) return;
      if (field.value.trim() && field.value !== lastExample.current) setReplaced(field.value);
      field.value = lastExample.current = (event as CustomEvent<string>).detail;
      field.focus();
    };
    window.addEventListener(EXAMPLE_EVENT, use);
    return () => window.removeEventListener(EXAMPLE_EVENT, use);
  }, []);
  // Spoken words join what is typed; Send then submits the request as typed words would.
  function speak(text: string, submit: boolean) {
    const field = input.current;
    if (!field) return;
    field.value = withSpoken(field.value, text).slice(0, 4000);
    if (submit) field.form?.requestSubmit(); else field.focus();
  }
  return <SafeForm action={createArtifactSafely} className="relative grid gap-2">
    <label htmlFor="artifact-prompt" className="text-sm font-medium">Describe your report or tool</label>
    <textarea ref={input} id="artifact-prompt" name="prompt" required maxLength={4000} rows={4} defaultValue={defaultValue} placeholder={placeholder} aria-describedby="artifact-prompt-help"
      onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit(); }}
      className="w-full resize-y rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
    {replaced && <button type="button" onClick={() => { if (input.current) { input.current.value = replaced; input.current.focus(); } setReplaced(""); }} className="justify-self-start text-xs underline">Restore my text</button>}
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span id="artifact-prompt-help" className="text-xs text-muted-foreground">Build uses an AI request and your real data, read-only. Ctrl or Cmd+Enter also builds. Usage is under Settings.</span>
      <span className="flex items-center gap-1.5"><VoiceInput onSend={text => speak(text, true)} onDone={text => speak(text, false)} /><button type="submit" className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 whitespace-nowrap"><Sparkles className="size-3.5" aria-hidden="true" />Build</button></span>
    </div>
  </SafeForm>;
}

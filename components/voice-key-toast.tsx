"use client";

import { useEffect } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { VOICE_NEEDS_OPENAI_KEY } from "@/lib/ai/voice-access";

/** The same temporary explanation for calls, dictation and voice samples. */
export function VoiceKeyToast({ onDismiss }: { onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 8000);
    return () => clearTimeout(timer);
  }, [onDismiss]);
  return <div role="alert" className="fixed right-4 bottom-24 left-4 z-[100] flex items-start gap-3 rounded-xl border border-border bg-card p-4 text-sm font-normal text-foreground shadow-lg sm:left-auto sm:max-w-sm">
    <span>{VOICE_NEEDS_OPENAI_KEY} <Link href="/settings#ai-access" className="underline">Add one in Settings</Link></span>
    <button type="button" onClick={onDismiss} aria-label="Dismiss voice notice" className="grid size-7 shrink-0 place-items-center rounded-md hover:bg-muted"><X className="size-4" aria-hidden="true" /></button>
  </div>;
}

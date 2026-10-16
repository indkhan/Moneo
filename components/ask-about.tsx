"use client";

import { MessageCircleQuestion } from "lucide-react";

export type AskSeed = { question: string; about: { kind: string; id?: string; label: string } };
export const ASK_EVENT = "moneo-ask";

/** Opens Ask Moneo with a drafted question about one transaction, account, chart or proposal. */
export function AskAbout({ question, about, label = "Ask about this", className }: AskSeed & { label?: string; className?: string }) {
  return <button type="button" onClick={() => window.dispatchEvent(new CustomEvent<AskSeed>(ASK_EVENT, { detail: { question, about } }))}
    className={className ?? "inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"}>
    <MessageCircleQuestion className="size-3.5" aria-hidden="true" />{label}
  </button>;
}

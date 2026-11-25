"use client";

import { useActionState } from "react";
import { skipAiSetup } from "./first-steps-actions";

export function SkipAiSetup() {
  const [state, action, pending] = useActionState(skipAiSetup, {});
  return <form action={action} className="inline-flex flex-col gap-1">
    <button disabled={pending} className="min-h-11 rounded-lg px-3 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 sm:min-h-9">{pending ? "Skipping…" : "Skip for now"}</button>
    {state.error && <span role="alert" className="text-xs text-danger">{state.error}</span>}
  </form>;
}

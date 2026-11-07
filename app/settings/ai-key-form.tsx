"use client";

import { useActionState } from "react";
import { saveAiKey, type AiKeyState } from "./ai-key-actions";
import type { AiKeyName } from "@/lib/ai/keys";
import type { ServiceKeyStatus } from "@/lib/service-keys";

const button = "min-h-10 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50";

/** Paste, replace or remove one API key. The saved key is never sent back to the browser, only its last four characters. */
export function AiKeyForm({ name, label, placeholder, status }: { name: AiKeyName; label: string; placeholder: string; status: ServiceKeyStatus }) {
  const [state, action, pending] = useActionState<AiKeyState, FormData>(saveAiKey, {});
  return <form action={action} className="mt-3 grid gap-2">
    <input type="hidden" name="name" value={name} />
    <p className="text-sm text-muted-foreground">{status.source === "app" ? `Saved in Moneo, ending in ${status.hint}.`
      : status.source === "env" ? `Read from .env, ending in ${status.hint}. Save one here to replace it.` : "Not set up."}</p>
    <label className="grid gap-1 text-sm font-medium">{status.source ? `Replace ${label}` : label}
      <input name="key" type="password" autoComplete="off" spellCheck={false} placeholder={placeholder} className="min-h-10 min-w-0 rounded-lg border border-border bg-card px-3 py-2 text-sm font-normal" /></label>
    <div className="flex flex-wrap gap-2">
      <button disabled={pending} name="operation" value="save" className={button}>{pending ? "Checking…" : "Save key"}</button>
      {status.source === "app" && <button disabled={pending} name="operation" value="remove" formNoValidate className={button}
        onClick={event => { if (!window.confirm(`Remove the saved ${label}?`)) event.preventDefault(); }}>Remove</button>}
    </div>
    {state.error && <p role="alert" className="text-sm text-danger">{state.error}</p>}
    {state.saved && <p role="status" className="text-sm">Key checked and saved.</p>}
  </form>;
}

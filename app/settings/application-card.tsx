"use client";

import { useActionState } from "react";
import type { ApplicationState } from "@/lib/application";
import { saveApplication } from "./application-actions";

export const applicationButton = "min-h-10 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50";

export function ApplicationCard({ initial }: { initial: ApplicationState }) {
  const [state, save, pending] = useActionState(saveApplication, initial);
  const disabled = pending || !state.local || !state.supported;
  return <section id="application" aria-labelledby="application-title" className="scroll-mt-20 rounded-xl border border-border bg-card p-6">
    <h2 id="application-title" className="text-sm font-medium">Application</h2>
    <p className="mt-1 text-sm text-muted-foreground">Run Moneo in the background when you sign in to this computer. Docker must be installed; on Linux, Docker Engine must already be enabled or Docker Desktop installed.</p>
    {!state.local && <p className="mt-3 text-sm text-warning">Open Moneo on the computer running it to manage startup and updates.</p>}
    {!state.supported && <p className="mt-3 text-sm text-warning">Automatic startup supports Windows, macOS and Linux desktop sessions.</p>}
    <form action={save} className="mt-4 space-y-3">
      <fieldset disabled={disabled} className="space-y-3 disabled:opacity-60">
        <label className="flex min-h-10 items-center gap-3 text-sm"><input type="checkbox" name="startup" defaultChecked={state.startup} />Start Moneo when I sign in</label>
        <label className="flex min-h-10 items-center gap-3 text-sm"><input type="checkbox" name="openBrowser" defaultChecked={state.openBrowser} />Open the browser when Moneo starts automatically</label>
      </fieldset>
      <button disabled={disabled} className={applicationButton}>{pending ? "Saving…" : "Save application settings"}</button>
    </form>
    {state.error && <p role="alert" className="mt-3 text-sm text-danger">{state.error}</p>}
  </section>;
}

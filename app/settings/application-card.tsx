"use client";

import { useActionState, useState, useTransition } from "react";
import type { ApplicationState } from "@/lib/application";
import { checkApplicationUpdate, installApplicationUpdate, saveApplication } from "./application-actions";

export const applicationButton = "min-h-10 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50";

export function ApplicationCard({ initial }: { initial: ApplicationState }) {
  const [state, save, pending] = useActionState(saveApplication, initial);
  const [checked, setChecked] = useState<ApplicationState | null>(null);
  const [updating, transition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const updates = checked ?? state;
  const disabled = pending || updating || !state.local || !state.supported;
  return <section id="application" aria-labelledby="application-title" className="scroll-mt-20 rounded-xl border border-border bg-card p-6">
    <h2 id="application-title" className="text-sm font-medium">Application</h2>
    <p className="mt-1 text-sm text-muted-foreground">Run Moneo in the background when you sign in to this computer. Docker must be installed; on Linux, Docker Engine must already be enabled or Docker Desktop installed.</p>
    {!state.local && <p className="mt-3 text-sm text-warning">Open Moneo on the computer running it to manage startup and updates.</p>}
    {!state.supported && <p className="mt-3 text-sm text-warning">Automatic startup supports Windows, macOS and Linux desktop sessions.</p>}
    <form action={save} className="mt-4 space-y-3">
      <fieldset disabled={disabled} className="space-y-3 disabled:opacity-60">
        <label className="flex min-h-10 items-center gap-3 text-sm"><input type="checkbox" name="startup" defaultChecked={state.startup} />Start Moneo when I sign in</label>
        <label className="flex min-h-10 items-center gap-3 text-sm"><input type="checkbox" name="openBrowser" defaultChecked={state.openBrowser} />Open the browser when Moneo starts automatically</label>
        <label className="flex min-h-10 items-center gap-3 text-sm"><input type="checkbox" name="checkUpdates" defaultChecked={state.checkUpdates} />Check GitHub for releases once a day</label>
        <p className="text-xs text-muted-foreground">Optional. Checks send no financial data. Updates are installed only when you choose Update now.</p>
      </fieldset>
      <button disabled={disabled} className={applicationButton}>{pending ? "Saving…" : "Save application settings"}</button>
    </form>
    {state.error && <p role="alert" className="mt-3 text-sm text-danger">{state.error}</p>}
    <div className="mt-6 border-t border-border pt-4">
      <h3 className="text-sm font-medium">Updates</h3>
      <p className="mt-1 break-words text-sm text-muted-foreground">Installed version: {updates.version}</p>
      {!updates.managed && <p className="mt-2 text-sm text-muted-foreground">Start Moneo with npm start to install updates here. Development and test servers cannot update themselves.</p>}
      {updates.release ? <div className="mt-3 rounded-lg bg-muted p-4">
        <p className="break-words text-sm font-medium">Update available: {updates.release.name}</p>
        <a href={updates.release.url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm underline">See release notes</a>
        <details className="mt-2 text-sm"><summary className="cursor-pointer">What changed</summary><p className="mt-2 whitespace-pre-wrap break-words">{updates.release.notes || "No release notes were provided."}</p></details>
        <p className="mt-3 text-sm text-muted-foreground">Moneo will pause while it backs up your data, installs and restarts. Keep this computer awake.</p>
        <button type="button" disabled={disabled || !updates.managed} className={`${applicationButton} mt-3`} onClick={() => {
          if (!window.confirm("Update Moneo now? Moneo will pause while a local backup is created and the release is installed. Keep this computer awake.")) return;
          transition(async () => {
            try {
              const result = await installApplicationUpdate({ tag: updates.release!.tag, sha: updates.release!.sha });
              if (result.url) window.location.assign(result.url);
              else setError(result.error ?? "Could not start the update.");
            } catch { setError("The connection was lost. Check the launcher log on this computer before trying again."); }
          });
        }}>{updating ? "Preparing…" : "Update now"}</button>
      </div> : <p role="status" className="mt-2 text-sm text-muted-foreground">{updates.checkedAt ? "No newer published release was found." : "Releases have not been checked yet."}</p>}
      <button type="button" disabled={disabled} className={`${applicationButton} mt-3`} onClick={() => transition(async () => {
        setError(null);
        try { setChecked(await checkApplicationUpdate()); } catch { setError("Could not check for updates. Try again later."); }
      })}>{updating ? "Checking…" : "Check now"}</button>
      {updates.checkedAt && <p className="mt-2 text-xs text-muted-foreground">Last checked: {new Date(updates.checkedAt).toISOString().replace("T", " ").slice(0, 16)} UTC</p>}
      {(error || updates.updateError) && <p role="alert" className="mt-3 text-sm text-danger">{error || updates.updateError}</p>}
    </div>
  </section>;
}

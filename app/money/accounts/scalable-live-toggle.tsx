"use client";

import { startTransition, useActionState, useState } from "react";
import { setScalableArtifactDataSafely } from "./actions";

export function ScalableLiveToggle({ live }: { live: boolean }) {
  const [checked, setChecked] = useState(live);
  const [state, submit, pending] = useActionState(setScalableArtifactDataSafely, {});
  return <form className="border-t border-border pt-4">
    <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1 size-4" checked={checked} disabled={pending}
      onChange={event => { const next = event.target.checked; setChecked(next); const form = new FormData(); form.set("artifact_scalable_data", next ? "live" : "snapshot"); startTransition(() => submit(form)); }} />
      <span><strong className="block">Live Scalable data in artifacts</strong><span className="text-muted-foreground">Off: artifact Pages and Home cards show your Scalable portfolio as of the last sync, the same figures as Wealth. On: they read Scalable live each time they open, with current prices and quotes and charts for any security, but they load slower and show an error when Scalable can&apos;t be reached.</span></span></label>
    {state.error && <p role="alert" className="mt-2 text-sm text-danger">{state.error}</p>}
  </form>;
}

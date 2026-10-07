"use client";

import { saveTripState } from "./actions";
import { useStateDraft, StateDraftRecovery } from "./use-state-draft";

export function TripStateForm({ artifactId, costMinor, stateVersion, currency }: { artifactId: string; costMinor: string; stateVersion: number; currency: string }) {
  const draft = useStateDraft(costMinor, stateVersion, saveTripState);
  return <>
    <form action={draft.action} className="mt-4 flex flex-wrap items-end gap-3">
      <input type="hidden" name="artifactId" value={artifactId} />
      <input type="hidden" name="expectedVersion" value={draft.expectedVersion} />
      <label className="text-sm">Cost in minor units ({currency})<input name="costMinor" type="number" min="0" max="10000000" step="1" value={draft.value} disabled={draft.busy} onChange={event => draft.edit(event.target.value)} className="mt-1 block rounded border border-border bg-card px-3 py-2" /></label>
      <button disabled={draft.busy || draft.conflict} className="rounded border border-border bg-card px-3 py-2">Save and recalculate</button>
    </form>
    <StateDraftRecovery {...draft} />
  </>;
}

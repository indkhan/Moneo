"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// A refreshed server revision cannot silently become the base of an existing draft.
export function useStateDraft<T>(initial: T, version: number, save: (form: FormData) => Promise<{ error: string } | { conflict: true } | { saved: true; version: number; value: T }>) {
  const router = useRouter();
  const [local, setLocal] = useState<{ value: T; version: number } | null>(null);
  const [acknowledged, setAcknowledged] = useState<{ value: T; version: number } | null>(null);
  const [serverConflict, setServerConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  // A save acknowledgement is newer evidence than a cached route payload.
  const saved = acknowledged && acknowledged.version > version ? acknowledged : { value: initial, version };
  const value = local?.value ?? saved.value;
  const expectedVersion = local?.version ?? saved.version;
  const conflict = serverConflict || expectedVersion !== saved.version;
  function edit(next: T | ((previous: T) => T)) {
    setLocal({ value: typeof next === "function" ? (next as (previous: T) => T)(value) : next, version: expectedVersion });
    setMessage("");
  }
  async function action(form: FormData) {
    setBusy(true); setMessage("");
    // Keep the submitted draft even if a refresh arrives while the request is pending.
    setLocal({ value, version: expectedVersion });
    form.set("expectedVersion", String(expectedVersion));
    try {
      const result = await save(form);
      if ("error" in result) { setMessage(result.error); return; }
      if ("conflict" in result) {
        setServerConflict(true);
        setMessage("Saved inputs changed. Your draft is preserved. Review the latest inputs before choosing how to continue.");
      } else {
        setAcknowledged({ value: result.value, version: result.version });
        setLocal(null); setServerConflict(false); setMessage("Inputs saved.");
      }
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Inputs could not be saved. Your draft is preserved."); }
    finally { setBusy(false); }
  }
  function reload() { setLocal(null); setServerConflict(false); setMessage(""); }
  function rebase() { setLocal({ value, version: saved.version }); setServerConflict(false); setMessage("Draft now uses the latest revision. Save inputs to confirm replacement."); }
  return { value, edit, expectedVersion, conflict, busy, message, action, reload, rebase, refresh: () => router.refresh(), canRebase: expectedVersion !== saved.version, savedValue: saved.value };
}

export function StateDraftRecovery({ conflict, busy, message, reload, rebase, refresh, canRebase, savedValue }: Pick<ReturnType<typeof useStateDraft>, "conflict" | "busy" | "message" | "reload" | "rebase" | "refresh" | "canRebase" | "savedValue">) {
  return <>
    <button type="button" disabled={busy} onClick={refresh} className="mt-2 rounded border px-3 py-1 text-sm">Check saved inputs</button>
    {conflict && <div role="alert" className="mt-3 text-sm">
      <p>Saved inputs changed. Your draft is preserved. Review the current saved inputs before replacing them.</p>
      <p>Current saved inputs: {JSON.stringify(savedValue)}</p>
      <button type="button" disabled={busy} onClick={reload} className="mt-2 rounded border px-3 py-1">Reload saved inputs</button>
      <button type="button" disabled={busy || !canRebase} onClick={rebase} className="ml-2 rounded border px-3 py-1">Keep my draft against latest inputs</button>
    </div>}
    {message && <p role="status" className="mt-2 text-sm">{message}</p>}
  </>;
}

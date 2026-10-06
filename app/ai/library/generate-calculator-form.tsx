"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FALLBACK_CALCULATORS } from "@/lib/artifacts/templates";
import type { ArtifactKind } from "@/lib/artifacts/spec";

type Draft = {
  baseVersionId: string | null;
  source: string;
  manifest: unknown;
  rationale?: string;
  validation: { ok: boolean; errors?: string[]; warnings?: string[] };
};

export function GenerateCalculatorForm({
  artifactId,
  kind,
  activeVersionId,
}: {
  artifactId: string;
  kind: ArtifactKind;
  activeVersionId: string | null;
}) {
  const router = useRouter();
  const [description, setDescription] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState("");
  const [working, setWorking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const active = useRef<{ id: string; controller: AbortController } | null>(null);

  async function suggest() {
    setWorking(true);
    setStatus("");
    setDraft(null);
    const generation = { id: crypto.randomUUID(), controller: new AbortController() };
    active.current = generation;
    try {
      const res = await fetch("/api/artifacts/calculator/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ artifactId, description, requestId: generation.id }),
        signal: generation.controller.signal,
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error ?? "AI suggestion failed");
      // Replayed/retained results keep the server's original source revision.
      // Legacy drafts without one require an explicit replacement decision.
      setDraft({ ...payload, baseVersionId: payload.baseVersionId ?? null });
      setConflict(false);
      setStatus("Completed. Draft retained in Activity; review it before saving a version.");
    } catch (err) {
      setStatus(generation.controller.signal.aborted ? "Canceled" : err instanceof Error ? err.message : "AI suggestion failed");
    } finally {
      setWorking(false);
      if (active.current?.id === generation.id) active.current = null;
    }
  }

  async function stop() {
    const generation = active.current;
    if (!generation) return;
    try {
      const response = await fetch(`/api/artifacts/generation/${generation.id}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not stop generation");
      if (payload.status === "canceled") { generation.controller.abort(); setDraft(null); setStatus("Canceled"); }
      else setStatus(`Request is ${payload.status}`);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not stop generation"); }
  }

  async function save(source: string, manifest: unknown, expectedActiveVersionId = draft?.baseVersionId ?? null) {
    setSaving(true);
    setStatus("");
    try {
      const res = await fetch(`/api/artifacts/${artifactId}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, manifest, expectedActiveVersionId }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        if (res.status === 409) { setConflict(true); router.refresh(); }
        throw new Error(payload?.error ?? "Save failed");
      }
      if (payload?.status === "failed") {
        setStatus(
          `Candidate failed validation and was NOT activated: ${(payload?.validation?.errors ?? []).join("; ")}`,
        );
      } else {
        setStatus("Saved as new active version.");
        setDraft(null); setConflict(false);
      }
      router.refresh();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  function useFallback() {
    const fb = FALLBACK_CALCULATORS[kind];
    setDraft({
      baseVersionId: activeVersionId,
      source: fb.source,
      manifest: fb.manifest,
      rationale: `${fb.label} (deterministic fallback, no AI used)`,
      validation: { ok: true },
    });
    setStatus("");
    setConflict(false);
  }

  return (
    <section aria-label="AI-generated calculator" className="mt-8 rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="text-lg font-semibold">Generate calculator code</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        AI drafts a tiny pure calculator. Nothing is saved until you choose Save. Failed
        candidates never replace the active version.
      </p>
      <label className="mt-3 block text-sm font-medium" htmlFor="calc-description">
        What should the calculator compute?
      </label>
      <textarea
        id="calc-description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        maxLength={500}
        rows={3}
        placeholder="e.g. average daily dining spend from the snapshot"
        className="mt-2 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm"
      />
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={working || saving || description.trim().length === 0}
          onClick={suggest}
          className="rounded-lg bg-brand px-3 py-2 font-medium text-white hover:opacity-90 text-sm disabled:opacity-50"
        >
          {working ? "Asking AI…" : "Suggest calculator"}
        </button>
        {working && <button type="button" onClick={stop} className="rounded border px-3 py-2 text-sm">Stop generation</button>}
        <button type="button" onClick={useFallback} disabled={working || saving} className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50">
          Use safe fallback
        </button>
        {draft && (
          <button
            type="button"
            disabled={working || saving}
            onClick={suggest}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-muted"
          >
            Retry suggestion
          </button>
        )}
      </div>

      {draft && (
        <div className="mt-4 space-y-3 text-sm">
          {(conflict || draft.baseVersionId !== activeVersionId) && <div role="alert">
            <p>The active version changed. Your draft is preserved. Review the current version in history before replacing it, or discard this draft.</p>
            <button type="button" disabled={saving || draft.validation.ok === false || (conflict && draft.baseVersionId === activeVersionId)} onClick={() => save(draft.source, draft.manifest, activeVersionId)} className="mt-2 rounded border px-3 py-2">Replace current version with this draft</button>
            <button type="button" disabled={saving} onClick={() => { setDraft(null); setConflict(false); setStatus(""); }} className="ml-2 rounded border px-3 py-2">Discard draft</button>
          </div>}
          {draft.rationale && (
            <p>
              <span className="font-medium">Rationale:</span> {draft.rationale}
            </p>
          )}
          <div>
            <p className="font-medium">Proposed source (inspect before saving)</p>
            <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted p-3 font-mono text-xs">
              {draft.source}
            </pre>
          </div>
          <div>
            <p className="font-medium">Manifest</p>
            <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-3 font-mono text-xs">
              {JSON.stringify(draft.manifest, null, 2)}
            </pre>
          </div>
          {draft.validation.ok === false && (
            <ul className="rounded border border-destructive p-3 text-destructive">
              {(draft.validation.errors ?? []).map((e) => (
                <li key={e}>• {e}</li>
              ))}
            </ul>
          )}
          {draft.validation.ok === true && draft.validation.warnings?.length ? (
            <ul className="rounded-xl border border-border bg-card p-4 shadow-sm text-muted-foreground">
              {draft.validation.warnings.map((w) => (
                <li key={w}>• {w}</li>
              ))}
            </ul>
          ) : null}
          <button
            type="button"
            disabled={saving || draft.validation.ok === false}
            onClick={() => save(draft.source, draft.manifest)}
            className="rounded-lg bg-brand px-3 py-2 font-medium text-white hover:opacity-90 text-sm disabled:opacity-50"
            title={
              draft.validation.ok === false
                ? "Fix validation errors before saving (or save via the editor to record a failed attempt)"
                : "Save as new version"
            }
          >
            {saving ? "Saving…" : "Save as new version"}
          </button>
          {draft.validation.ok === false && (
            <p className="text-xs text-muted-foreground">
              This draft failed pre-save validation. Use Retry or edit it below; saving a failing
              candidate records a failed version and preserves the active one.
            </p>
          )}
        </div>
      )}

      {status && (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          {status}
        </p>
      )}
    </section>
  );
}

"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FALLBACK_CALCULATORS } from "@/lib/artifacts/templates";
import type { ArtifactKind } from "@/lib/artifacts/spec";

type Draft = {
  source: string;
  manifest: unknown;
  rationale?: string;
  validation: { ok: boolean; errors?: string[]; warnings?: string[] };
};

export function GenerateCalculatorForm({
  artifactId,
  kind,
}: {
  artifactId: string;
  kind: ArtifactKind;
}) {
  const router = useRouter();
  const [description, setDescription] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState("");
  const [working, setWorking] = useState(false);
  const [saving, setSaving] = useState(false);
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
      setDraft(payload as Draft);
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

  async function save(source: string, manifest: unknown) {
    setSaving(true);
    setStatus("");
    try {
      const res = await fetch(`/api/artifacts/${artifactId}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, manifest }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error ?? "Save failed");
      if (payload?.status === "failed") {
        setStatus(
          `Candidate failed validation and was NOT activated: ${(payload?.validation?.errors ?? []).join("; ")}`,
        );
      } else {
        setStatus("Saved as new active version.");
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
      source: fb.source,
      manifest: fb.manifest,
      rationale: `${fb.label} (deterministic fallback, no AI used)`,
      validation: { ok: true },
    });
    setStatus("");
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
          disabled={working || description.trim().length === 0}
          onClick={suggest}
          className="rounded-lg bg-brand px-3 py-2 font-medium text-white hover:opacity-90 text-sm disabled:opacity-50"
        >
          {working ? "Asking AI…" : "Suggest calculator"}
        </button>
        {working && <button type="button" onClick={stop} className="rounded border px-3 py-2 text-sm">Stop generation</button>}
        <button type="button" onClick={useFallback} disabled={working} className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50">
          Use safe fallback
        </button>
        {draft && (
          <button
            type="button"
            disabled={working}
            onClick={suggest}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-muted"
          >
            Retry suggestion
          </button>
        )}
      </div>

      {draft && (
        <div className="mt-4 space-y-3 text-sm">
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

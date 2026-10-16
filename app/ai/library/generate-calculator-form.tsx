"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { DraftPreview } from "./draft-preview";
import { FALLBACK_CALCULATORS } from "@/lib/artifacts/templates";
import type { ArtifactKind } from "@/lib/artifacts/spec";

type Draft = {
  baseVersionId: string | null;
  source: string;
  manifest: unknown;
  rationale?: string;
  validation: { ok: boolean; errors?: string[]; warnings?: string[] };
};

const EMPTY_PARAMS: Record<string, number | string> = {};
export const DESCRIBE_KEY = "moneo:artifact-describe:";

export function GenerateCalculatorForm({
  artifactId,
  kind,
  activeVersionId,
  snapshot = null,
  initialParams = EMPTY_PARAMS,
  currency,
  locale,
}: {
  artifactId: string;
  kind: ArtifactKind;
  activeVersionId: string | null;
  snapshot?: unknown;
  initialParams?: Record<string, number | string>;
  currency?: string;
  locale?: string;
}) {
  const router = useRouter();
  const [description, setDescription] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState("");
  const [working, setWorking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const active = useRef<{ id: string; controller: AbortController } | null>(null);

  // The Library's "Describe a tool" hands its text over once (kept out of the URL),
  // so the first draft starts without typing the description twice.
  useEffect(() => {
    const key = `${DESCRIBE_KEY}${artifactId}`;
    let handed = "";
    try { handed = sessionStorage.getItem(key)?.slice(0, 500) ?? ""; } catch { /* Storage unavailable: the user can describe it here. */ }
    if (!handed.trim()) return;
    // Consume only when the draft actually starts (StrictMode re-runs effects).
    const timer = setTimeout(() => {
      try { sessionStorage.removeItem(key); } catch { /* Ignore. */ }
      setDescription(handed); void suggest(handed);
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot handoff on mount
  }, [artifactId]);

  async function suggest(text = description) {
    setWorking(true);
    setStatus("");
    setDraft(null);
    const generation = { id: crypto.randomUUID(), controller: new AbortController() };
    active.current = generation;
    try {
      const res = await fetch("/api/artifacts/calculator/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ artifactId, description: text, requestId: generation.id }),
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

  const button = "rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50";
  const primary = "rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50";
  return (
    <section aria-label="AI-generated calculator" className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="text-base font-semibold tracking-tight">Describe it</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        AI drafts a small pure calculator and the sandbox previews it below. Nothing is saved until
        you accept it with Save. Failed candidates never replace the active version.
      </p>
      <label className="mt-3 block text-sm font-medium" htmlFor="calc-description">
        What should the calculator compute?
      </label>
      <textarea
        id="calc-description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && description.trim() && !working && !saving) void suggest(); }}
        maxLength={500}
        rows={3}
        placeholder="e.g. average daily dining spend from the snapshot"
        className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={working || saving || description.trim().length === 0}
          onClick={() => suggest()}
          className={primary}
        >
          {working ? "Asking AI…" : "Suggest calculator"}
        </button>
        {working && <button type="button" onClick={stop} className={button}>Stop generation</button>}
        <button type="button" onClick={useFallback} disabled={working || saving} className={button}>
          Use safe fallback
        </button>
        {draft && (
          <button type="button" disabled={working || saving} onClick={() => suggest()} className={button}>
            Retry suggestion
          </button>
        )}
        <span className="text-xs text-muted-foreground">Ctrl/⌘ + Enter to suggest</span>
      </div>

      {draft && (
        <div className="mt-4 space-y-3 text-sm">
          {(conflict || draft.baseVersionId !== activeVersionId) && <div role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
            <p>The active version changed. Your draft is preserved. Review the current version in history before replacing it, or discard this draft.</p>
            <button type="button" disabled={saving || draft.validation.ok === false || (conflict && draft.baseVersionId === activeVersionId)} onClick={() => save(draft.source, draft.manifest, activeVersionId)} className={`mt-2 ${button}`}>Replace current version with this draft</button>
            <button type="button" disabled={saving} onClick={() => { setDraft(null); setConflict(false); setStatus(""); }} className={`ml-2 mt-2 ${button}`}>Discard draft</button>
          </div>}
          {draft.rationale && (
            <p>
              <span className="font-medium">Rationale:</span> {draft.rationale}
            </p>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="min-w-0 space-y-3">
              <div>
                <p className="font-medium">Proposed source (inspect before saving)</p>
                <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs">
                  {draft.source}
                </pre>
              </div>
              <details>
                <summary className="cursor-pointer font-medium">Manifest</summary>
                <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs">
                  {JSON.stringify(draft.manifest, null, 2)}
                </pre>
              </details>
            </div>
            <div className="min-w-0 rounded-lg border border-border p-3">
              <DraftPreview source={draft.source} manifestText={JSON.stringify(draft.manifest)} snapshot={snapshot} params={initialParams} currency={currency} locale={locale} />
            </div>
          </div>
          {draft.validation.ok === false && (
            <ul aria-label="Server validation errors" className="list-disc rounded-lg border border-destructive/40 bg-destructive/5 py-2 pl-8 pr-3 text-destructive">
              {(draft.validation.errors ?? []).map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          {draft.validation.ok === true && draft.validation.warnings?.length ? (
            <ul className="list-disc rounded-lg border border-border bg-muted py-2 pl-8 pr-3 text-muted-foreground">
              {draft.validation.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
          <button
            type="button"
            disabled={saving || draft.validation.ok === false}
            onClick={() => save(draft.source, draft.manifest)}
            className={primary}
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

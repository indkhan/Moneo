"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";

const CodeEditor = dynamic(() => import("@/components/code-editor").then(module => module.CodeEditor), {
  ssr: false,
  loading: () => <p role="status" className="h-[280px] rounded-lg border border-border bg-muted p-3 text-sm text-muted-foreground">Loading source editor…</p>,
});

type VersionRow = {
  id: string;
  version: number;
  status: string;
  error: string | null;
  created_at: string;
  manifest: unknown;
  source?: string;
};

export function VersionEditor({
  artifactId,
  activeVersionId,
  versions,
  currentSource,
  currentManifest,
}: {
  artifactId: string;
  activeVersionId: string | null;
  versions: VersionRow[];
  currentSource: string;
  currentManifest: unknown;
}) {
  const router = useRouter();
  const currentManifestText = JSON.stringify(currentManifest ?? {}, null, 2);
  const [local, setLocal] = useState<{ source: string; manifestText: string; baseVersionId: string | null; baseSource: string; baseManifest: string } | null>(null);
  const source = local?.source ?? currentSource;
  const manifestText = local?.manifestText ?? currentManifestText;
  const dirty = !!local && (source !== local.baseSource || manifestText !== local.baseManifest);
  // Reverted edits are clean and follow incoming active props too.
  if (local && !dirty) setLocal(null);
  const baseVersionId = dirty ? local!.baseVersionId : activeVersionId;
  const edit = useCallback((values: Partial<{ source: string; manifestText: string }>) => {
    setLocal(previous => ({ ...(previous ?? { source: currentSource, manifestText: currentManifestText,
      baseVersionId: activeVersionId, baseSource: currentSource, baseManifest: currentManifestText }), ...values }));
  }, [currentSource, currentManifestText, activeVersionId]);
  const editSource = useCallback((source: string) => edit({ source }), [edit]);
  const [serverConflict, setServerConflict] = useState(false);
  const conflict = serverConflict || baseVersionId !== activeVersionId;
  const [historyPage, setHistoryPage] = useState({ head: versions[0]?.id, older: [] as VersionRow[], cursor: undefined as number | null | undefined });
  const [loadingHistory, setLoadingHistory] = useState(false);
  if (historyPage.head !== versions[0]?.id) {
    setHistoryPage({ head: versions[0]?.id, older: [], cursor: undefined });
  }
  const history = [...versions, ...historyPage.older.filter(v => !versions.some(current => current.id === v.id))];
  const nextCursor = historyPage.cursor === undefined ? (versions.length === 20 ? versions.at(-1)!.version : null) : historyPage.cursor;
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(candidateSource = source, candidateManifest = manifestText, expectedActiveVersionId = baseVersionId, restoreTrustedVersionId?: string) {
    setSaving(true);
    setStatus("");
    let manifest: unknown;
    try {
      manifest = JSON.parse(candidateManifest);
    } catch {
      setStatus("Manifest is not valid JSON");
      setSaving(false);
      return;
    }
    try {
      const res = await fetch(`/api/artifacts/${artifactId}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(restoreTrustedVersionId ? { restoreTrustedVersionId, expectedActiveVersionId } : { source: candidateSource, manifest, expectedActiveVersionId }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        if (res.status === 409) { setServerConflict(true); router.refresh(); }
        throw new Error(payload?.error ?? "Save failed");
      }
      if (payload?.status === "failed") {
        setStatus(
          `Version ${payload?.version?.version ?? "?"} recorded as failed; active version preserved. Errors: ${(payload?.validation?.errors ?? []).join("; ")}`,
        );
      } else {
        setLocal(previous => previous && (previous.source !== source || previous.manifestText !== manifestText) ? previous : null);
        setServerConflict(false);
        setStatus(`Version ${payload?.version?.version ?? "?"} validated and activated.`);
      }
      router.refresh();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function loadOlder() {
    if (nextCursor === null || loadingHistory) return;
    setLoadingHistory(true);
    try {
      const res = await fetch(`/api/artifacts/${artifactId}/versions?before=${nextCursor}`);
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error ?? "History unavailable");
      // Ignore an old page response after a refreshed history head resets pagination.
      setHistoryPage(previous => previous.head !== historyPage.head ? previous : { ...previous,
        older: [...previous.older, ...payload.versions.filter((v: VersionRow) => !previous.older.some(row => row.id === v.id))], cursor: payload.nextCursor });
    } catch (error) { setStatus(error instanceof Error ? error.message : "History unavailable"); }
    finally { setLoadingHistory(false); }
  }

  return (
    <section aria-label="Edit calculator version" className="mt-8 rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="text-lg font-semibold">Edit calculator version</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Edits create a new version. Validation (allowlist, manifest, QuickJS smoke test incl.
        missing data) runs before activation. Failed edits preserve the active version and
        artifact state.
      </p>
      <label className="mt-3 block text-sm font-medium" htmlFor="version-source">
        Source (pure function of input.snapshot + input.params)
      </label>
      <div id="version-source" className="mt-2">
        <CodeEditor value={source} onChange={editSource} />
      </div>
      <label className="mt-3 block text-sm font-medium" htmlFor="version-manifest">
        Manifest (JSON)
      </label>
      <textarea
        id="version-manifest"
        value={manifestText}
        onChange={(e) => edit({ manifestText: e.target.value })}
        rows={8}
        spellCheck={false}
        className="mt-2 w-full rounded-lg border border-border bg-card px-3 py-2 font-mono text-xs"
      />
      <button
        type="button"
        disabled={saving || source.trim().length === 0}
        onClick={() => save()}
        className="mt-3 rounded-lg bg-brand px-3 py-2 font-medium text-white hover:opacity-90 text-sm disabled:opacity-50"
      >
        {saving ? "Validating…" : "Save new version"}
      </button>
      <button type="button" disabled={saving} onClick={() => { setLocal(null); setServerConflict(false); setStatus(""); router.refresh(); }} className="ml-2 rounded border px-3 py-2 text-sm">
        Reload current version
      </button>
      {conflict && <div role="alert" className="mt-3 text-sm">
        <p>The active version changed. Your unsaved work is preserved on its original base. Review the current version in history, then reload to discard local edits or explicitly replace it.</p>
        <p>Edited base: {baseVersionId ?? "none"}. Current active: {activeVersionId ?? "none"}.</p>
        <button type="button" disabled={saving || (serverConflict && baseVersionId === activeVersionId) || !dirty} onClick={() => save(source, manifestText, activeVersionId)} className="mt-2 rounded border px-3 py-2">
          Replace current version with my edits
        </button>
        {serverConflict && <button type="button" onClick={() => { setServerConflict(false); router.refresh(); }} className="ml-2 rounded border px-3 py-2">Review refreshed version</button>}
      </div>}
      {status && (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          {status}
        </p>
      )}

      <h3 className="mt-6 font-medium">Version history</h3>
      <ul className="mt-2 space-y-2 text-sm">
        {history.map((v) => (
          <li key={v.id} className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <p>
              v{v.version} · {v.status}
              {v.id === activeVersionId ? " · active" : ""}
              <span className="ml-2 text-xs text-muted-foreground">{v.created_at}</span>
            </p>
            {v.error && <p className="mt-1 text-destructive">{v.error}</p>}
            {v.source && <details className="mt-1">
              <summary className="cursor-pointer underline">Source</summary>
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs">{v.source}</pre>
            </details>}
            {v.status === "validated" && v.id !== activeVersionId && v.source && v.manifest !== null && typeof v.manifest === "object" && "runtime" in v.manifest && (v.manifest.runtime === "quickjs-calculator-v1" || v.manifest.runtime === "trusted") && <button type="button" disabled={saving || dirty || serverConflict} onClick={() => save(v.source!, JSON.stringify(v.manifest), activeVersionId, (v.manifest as { runtime: string }).runtime === "trusted" ? v.id : undefined)} className="mt-2 rounded border px-3 py-1 text-xs">Restore v{v.version} as a new version</button>}
            <details className="mt-1">
              <summary className="cursor-pointer underline">Manifest</summary>
              <pre className="mt-1 max-h-32 overflow-auto font-mono text-xs">
                {JSON.stringify(v.manifest, null, 2)}
              </pre>
            </details>
            {v.status === "failed" && v.source && (
              <button
                type="button"
                disabled={saving || dirty}
                className="mt-2 rounded border px-3 py-1 text-xs"
                onClick={() => {
                  edit({ source: v.source!, manifestText: JSON.stringify(v.manifest, null, 2) });
                  setStatus(`Loaded failed v${v.version} into the editor; fix and save to retry. Active version preserved until a candidate validates.`);
                }}
              >
                Retry this version (load into editor)
              </button>
            )}
          </li>
        ))}
        {!versions.length && <li className="text-muted-foreground">No versions yet.</li>}
      </ul>
      {dirty && <p className="mt-2 text-sm">Reload current version to discard local edits before restoring history.</p>}
      {nextCursor !== null && <button type="button" disabled={loadingHistory} onClick={loadOlder} className="mt-3 rounded border px-3 py-2 text-sm">{loadingHistory ? "Loading history…" : "Load older versions"}</button>}
    </section>
  );
}

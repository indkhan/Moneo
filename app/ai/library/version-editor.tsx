"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import Link from "next/link";
import { DraftPreview } from "./draft-preview";

const CodeEditor = dynamic(() => import("@/components/code-editor").then(module => module.CodeEditor), {
  ssr: false,
  loading: () => <p role="status" className="h-[360px] rounded-lg border border-border bg-muted p-3 text-sm text-muted-foreground">Loading source editor…</p>,
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

const EMPTY_PARAMS: Record<string, number | string> = {};

export function VersionEditor({
  artifactId,
  activeVersionId,
  versions,
  currentSource,
  currentManifest,
  snapshot = null,
  initialParams = EMPTY_PARAMS,
  currency,
  locale,
}: {
  artifactId: string;
  activeVersionId: string | null;
  versions: VersionRow[];
  currentSource: string;
  currentManifest: unknown;
  snapshot?: unknown;
  initialParams?: Record<string, number | string>;
  currency?: string;
  locale?: string;
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
        setStatus(`Version ${payload?.version?.version ?? "?"} recorded as failed; active version preserved. Errors: ${(payload?.validation?.errors ?? []).join("; ")}`);
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

  const button = "rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50";
  return (
    <section aria-label="Edit calculator version" className="rounded-xl border border-border bg-card shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Edit calculator version</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Edits create a new version. Validation (allowlist, manifest, QuickJS smoke test incl.
            missing data) runs before activation. Failed edits preserve the active version and
            artifact state.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          {dirty && <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700">Unsaved changes</span>}
          <Link href="/ai/library/sdk" target="_blank" className="font-medium text-brand underline-offset-4 hover:underline">SDK reference</Link>
        </div>
      </div>
      <div className="grid lg:grid-cols-2">
        <div className="min-w-0 space-y-3 p-5 lg:border-r lg:border-border">
          <label className="block text-sm font-medium" htmlFor="version-source">
            Source (pure function of input.snapshot + input.params)
          </label>
          <div id="version-source" className="overflow-hidden rounded-lg border border-border">
            <CodeEditor value={source} onChange={editSource} />
          </div>
          <label className="block text-sm font-medium" htmlFor="version-manifest">
            Manifest (JSON)
          </label>
          <textarea
            id="version-manifest"
            value={manifestText}
            onChange={(e) => edit({ manifestText: e.target.value })}
            rows={8}
            spellCheck={false}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs"
          />
        </div>
        <div className="min-w-0 border-t border-border p-5 lg:border-t-0">
          <DraftPreview source={source} manifestText={manifestText} snapshot={snapshot} params={initialParams} currency={currency} locale={locale} />
        </div>
      </div>
      <div className="space-y-3 border-t border-border px-5 py-4">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={saving || source.trim().length === 0}
            onClick={() => save()}
            className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Validating…" : "Save new version"}
          </button>
          <button type="button" disabled={saving} onClick={() => { setLocal(null); setServerConflict(false); setStatus(""); router.refresh(); }} className={button}>
            Reload current version
          </button>
        </div>
        {conflict && <div role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          <p>The active version changed. Your unsaved work is preserved on its original base. Review the current version in history, then reload to discard local edits or explicitly replace it.</p>
          <p className="mt-1 text-xs text-muted-foreground">Edited base: {baseVersionId ?? "none"}. Current active: {activeVersionId ?? "none"}.</p>
          <button type="button" disabled={saving || (serverConflict && baseVersionId === activeVersionId) || !dirty} onClick={() => save(source, manifestText, activeVersionId)} className={`mt-2 ${button}`}>
            Replace current version with my edits
          </button>
          {serverConflict && <button type="button" onClick={() => { setServerConflict(false); router.refresh(); }} className={`ml-2 mt-2 ${button}`}>Review refreshed version</button>}
        </div>}
        {status && (
          <p role="status" className="text-sm text-muted-foreground">
            {status}
          </p>
        )}
      </div>

      <div className="border-t border-border px-5 py-4">
        <h3 className="text-sm font-semibold">Version history</h3>
        <ul className="mt-2 divide-y divide-border rounded-lg border border-border text-sm">
          {history.map((v) => (
            <li key={v.id} className="px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium tabular-nums">v{v.version}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs ${v.status === "failed" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}>{v.status}</span>
                {v.id === activeVersionId && <span className="rounded-full bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand">active</span>}
                <time className="text-xs text-muted-foreground" dateTime={v.created_at}>{v.created_at}</time>
                <span className="ml-auto flex flex-wrap gap-1.5">
                  {v.status === "validated" && v.id !== activeVersionId && v.source && v.manifest !== null && typeof v.manifest === "object" && "runtime" in v.manifest && (v.manifest.runtime === "quickjs-calculator-v1" || v.manifest.runtime === "trusted") && <button type="button" disabled={saving || dirty || serverConflict} onClick={() => save(v.source!, JSON.stringify(v.manifest), activeVersionId, (v.manifest as { runtime: string }).runtime === "trusted" ? v.id : undefined)} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50">Restore v{v.version} as a new version</button>}
                  {v.source && <button
                    type="button"
                    disabled={saving || dirty}
                    className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                    onClick={() => {
                      edit({ source: v.source!, manifestText: JSON.stringify(v.manifest, null, 2) });
                      setStatus(v.status === "failed" ? `Loaded failed v${v.version} into the editor; fix and save to retry. Active version preserved until a candidate validates.` : `Loaded v${v.version} into the editor. Saving creates a new version.`);
                    }}
                  >
                    {v.status === "failed" ? "Retry this version (load into editor)" : "Load into editor"}
                  </button>}
                </span>
              </div>
              {v.error && <ul className="mt-1 list-disc pl-5 text-xs text-destructive">{v.error.split("; ").map(item => <li key={item}>{item}</li>)}</ul>}
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-muted-foreground">Code and manifest</summary>
                {v.source && <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs">{v.source}</pre>}
                <pre className="mt-1 max-h-32 overflow-auto rounded bg-muted p-2 font-mono text-xs">
                  {JSON.stringify(v.manifest, null, 2)}
                </pre>
              </details>
            </li>
          ))}
          {!versions.length && <li className="px-3 py-2.5 text-muted-foreground">No versions yet.</li>}
        </ul>
        {dirty && <p className="mt-2 text-sm text-muted-foreground">Reload current version to discard local edits before restoring history.</p>}
        {nextCursor !== null && <button type="button" disabled={loadingHistory} onClick={loadOlder} className={`mt-3 ${button}`}>{loadingHistory ? "Loading history…" : "Load older versions"}</button>}
      </div>
    </section>
  );
}

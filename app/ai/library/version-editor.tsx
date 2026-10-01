"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CodeEditor } from "@/components/code-editor";

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
  const [source, setSource] = useState(currentSource);
  const [manifestText, setManifestText] = useState(
    JSON.stringify(currentManifest ?? {}, null, 2),
  );
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(candidateSource = source, candidateManifest = manifestText) {
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
        body: JSON.stringify({ source: candidateSource, manifest }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error ?? "Save failed");
      if (payload?.status === "failed") {
        setStatus(
          `Version ${payload?.version?.version ?? "?"} recorded as failed; active version preserved. Errors: ${(payload?.validation?.errors ?? []).join("; ")}`,
        );
      } else {
        setStatus(`Version ${payload?.version?.version ?? "?"} validated and activated.`);
      }
      router.refresh();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
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
        <CodeEditor value={source} onChange={(v) => setSource(v)} />
      </div>
      <label className="mt-3 block text-sm font-medium" htmlFor="version-manifest">
        Manifest (JSON)
      </label>
      <textarea
        id="version-manifest"
        value={manifestText}
        onChange={(e) => setManifestText(e.target.value)}
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
      {status && (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          {status}
        </p>
      )}

      <h3 className="mt-6 font-medium">Version history</h3>
      <ul className="mt-2 space-y-2 text-sm">
        {versions.map((v) => (
          <li key={v.id} className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <p>
              v{v.version} · {v.status}
              {v.id === activeVersionId ? " · active" : ""}
              <span className="ml-2 text-xs text-muted-foreground">{v.created_at}</span>
            </p>
            {v.error && <p className="mt-1 text-destructive">{v.error}</p>}
            {v.status === "validated" && v.id !== activeVersionId && v.source && v.manifest !== null && typeof v.manifest === "object" && "runtime" in v.manifest && v.manifest.runtime === "quickjs-calculator-v1" && <button type="button" disabled={saving} onClick={() => save(v.source!, JSON.stringify(v.manifest))} className="mt-2 rounded border px-3 py-1 text-xs">Restore v{v.version} as a new version</button>}
            <details className="mt-1">
              <summary className="cursor-pointer underline">Manifest</summary>
              <pre className="mt-1 max-h-32 overflow-auto font-mono text-xs">
                {JSON.stringify(v.manifest, null, 2)}
              </pre>
            </details>
            {v.status === "failed" && v.source && (
              <button
                type="button"
                className="mt-2 rounded border px-3 py-1 text-xs"
                onClick={() => {
                  setSource(v.source!);
                  setManifestText(JSON.stringify(v.manifest ?? {}, null, 2));
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
    </section>
  );
}

"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function GenerationActions({ id, artifactId, purpose, status, result, activeVersionId }: { id: string; artifactId: string | null; purpose: string; status: string; result: Record<string, unknown> | null; activeVersionId: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [conflict, setConflict] = useState(false);
  const baseVersionId = typeof result?.baseVersionId === "string" ? result.baseVersionId : null;
  async function act(action: "stop" | "save", expectedActiveVersionId = baseVersionId) {
    setBusy(true); setMessage("");
    try {
      const path = action === "stop" ? `/api/artifacts/generation/${id}` : purpose === "calculator" ? `/api/artifacts/${artifactId}/versions` : "/api/artifacts/generate";
      const response = await fetch(path, { method: action === "stop" ? "DELETE" : "POST", headers: { "content-type": "application/json" },
        ...(action === "save" ? { body: JSON.stringify(purpose === "calculator" ? { source: result?.source, manifest: result?.manifest, expectedActiveVersionId } : { confirm: true, kind: result?.kind, name: result?.name }) } : {}) });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 409 && purpose === "calculator") { setConflict(true); router.refresh(); }
        throw new Error(data.error ?? "Action failed");
      }
      if (action === "stop") { setMessage(`Request is ${data.status}`); router.refresh(); }
      else if (data.status === "failed") setMessage("Draft failed current validation; the active version is preserved.");
      else router.push(`/ai/library/${artifactId ?? data.id}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Action failed"); }
    finally { setBusy(false); }
  }
  const validation = result?.validation as { ok?: boolean } | undefined;
  return <div className="space-y-2">
    {["queued", "running"].includes(status) && <button disabled={busy} onClick={() => act("stop")} className="rounded border px-3 py-2">Stop generation</button>}
    {status === "completed" && result && (purpose !== "calculator" || validation?.ok) && <button disabled={busy} onClick={() => act("save")} className="rounded bg-brand px-3 py-2 text-white">{purpose === "calculator" ? "Save reviewed draft as a new version" : "Create reviewed tool proposal"}</button>}
    {purpose === "calculator" && status === "completed" && result && (conflict || baseVersionId !== activeVersionId) && <div role="alert">
      <p>The active version changed or this legacy draft has no recorded base. The retained draft is preserved. Open the tool&apos;s version history to review the current source before explicitly replacing it.</p>
      <button disabled={busy || !validation?.ok || !activeVersionId || (conflict && baseVersionId === activeVersionId)} onClick={() => act("save", activeVersionId)} className="rounded border px-3 py-2">Replace current version with retained draft</button>
    </div>}
    {message && <p role="status">{message}</p>}
  </div>;
}

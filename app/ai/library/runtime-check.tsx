"use client";

import { useState } from "react";
import { runIsolatedArtifact } from "@/lib/artifacts/run";

export function RuntimeCheck({ source = "input => input.a + input.b", input = { a: 2, b: 3 } }: { source?: string; input?: unknown }) {
  const [status, setStatus] = useState("");
  return <div className="mt-8 rounded-lg border p-4 text-sm">
    <p>Isolated artifact runtime prototype</p>
    <button type="button" className="mt-2 rounded border px-3 py-1" onClick={async () => {
      setStatus("Running in QuickJS/Web Worker…");
      try {
        const result = await runIsolatedArtifact(source, input);
        setStatus(`QuickJS/Web Worker returned ${JSON.stringify(result)}`);
      } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    }}>Run isolation check</button>
    <p role="status" className="mt-2">{status}</p>
  </div>;
}

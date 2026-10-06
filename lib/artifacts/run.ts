import { type CalculatorManifest } from "./spec";

export function runIsolatedArtifact(source: string, input: unknown, signal?: AbortSignal, manifest?: CalculatorManifest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("Artifact stopped", "AbortError")); return; }
    const worker = new Worker(new URL("./runtime.worker.ts", import.meta.url), { type: "module" });
    let finished = false;
    const abort = () => finish(new DOMException("Artifact stopped", "AbortError"), true);
    const timeout = setTimeout(() => finish(new Error("Artifact timed out")), 5000);
    function finish(value: unknown, failed = value instanceof Error) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      if (failed) reject(value);
      else resolve(value);
    }
    worker.onmessage = (event: MessageEvent<{ output?: unknown; error?: string }>) =>
      event.data.error ? finish(new Error(event.data.error)) : finish(event.data.output);
    worker.onerror = () => finish(new Error("Artifact worker failed"));
    signal?.addEventListener("abort", abort, { once: true });
    try { worker.postMessage({ source, input, manifest }); } catch (error) { finish(error, true); }
  });
}

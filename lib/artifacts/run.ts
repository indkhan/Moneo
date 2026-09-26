export function runIsolatedArtifact(source: string, input: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./runtime.worker.ts", import.meta.url), { type: "module" });
    const timeout = setTimeout(() => finish(new Error("Artifact timed out")), 5000);
    function finish(value: unknown, failed = value instanceof Error) {
      clearTimeout(timeout);
      worker.terminate();
      if (failed) reject(value);
      else resolve(value);
    }
    worker.onmessage = (event: MessageEvent<{ output?: unknown; error?: string }>) =>
      event.data.error ? finish(new Error(event.data.error)) : finish(event.data.output);
    worker.onerror = () => finish(new Error("Artifact worker failed"));
    worker.postMessage({ source, input });
  });
}

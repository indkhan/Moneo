import { calculatorManifestSchema, normalizeCalculatorParams } from "./spec";
import { evaluateIsolated } from "./isolate";

self.onmessage = async (event: MessageEvent<{ source: string; input: unknown; manifest?: unknown }>) => {
  try {
    let input = event.data.input;
    if (event.data.manifest !== undefined) {
      const manifest = calculatorManifestSchema.parse(event.data.manifest);
      if (!input || typeof input !== "object" || !("params" in input) || !input.params || typeof input.params !== "object" || Array.isArray(input.params)) throw new Error("Calculator params must be an object");
      input = { ...input, params: normalizeCalculatorParams(manifest, input.params as Record<string, unknown>) };
    }
    self.postMessage({ output: await evaluateIsolated(event.data.source, input) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};

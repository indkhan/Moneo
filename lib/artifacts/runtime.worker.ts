import { evaluateIsolated } from "./isolate";

self.onmessage = async (event: MessageEvent<{ source: string; input: unknown }>) => {
  try {
    self.postMessage({ output: await evaluateIsolated(event.data.source, event.data.input) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};

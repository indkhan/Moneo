import { getQuickJS } from "quickjs-emscripten";

export async function evaluateIsolated(source: string, input: unknown): Promise<unknown> {
  if (source.length > 20_000) throw new Error("Artifact source is too large");
  const quickJS = await getQuickJS();
  const runtime = quickJS.newRuntime();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  runtime.setMaxStackSize(256 * 1024);
  const deadline = Date.now() + 500;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const context = runtime.newContext();
  try {
    const inputJson = JSON.stringify(input ?? null);
    const result = context.evalCode(`"use strict"; (${source})(${inputJson})`);
    if (result.error) {
      const error = context.dump(result.error);
      result.error.dispose();
      throw new Error(String(error?.message ?? error));
    }
    const output = context.dump(result.value);
    result.value.dispose();
    return output;
  } finally {
    context.dispose();
    runtime.dispose();
  }
}

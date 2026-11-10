import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline } from "quickjs-emscripten-core";
import releaseSync from "@jitl/quickjs-wasmfile-release-sync";

const engine = newQuickJSWASMModuleFromVariant(releaseSync);

/** Fresh WASM runtime with no host functions, network, filesystem or credentials. */
export async function investigationCode(code: string, data: unknown) {
  const input = JSON.stringify(data);
  if (input.length > 8_000_000 || code.length > 30_000) throw new Error("Calculation input is too large");
  const runtime = (await engine).newRuntime();
  runtime.setMemoryLimit(64 * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 1000));
  const vm = runtime.newContext();
  try {
    const result = vm.evalCode(`JSON.stringify((function(data) { "use strict";\n${code}\n})(JSON.parse(${JSON.stringify(input)})), (_, value) => typeof value === "bigint" ? value.toString() : value)`, "investigation.js");
    if (result.error) {
      const error = vm.dump(result.error);
      result.error.dispose();
      throw new Error(`Calculation failed: ${error?.message ?? String(error)}`);
    }
    const output = vm.getString(result.value);
    result.value.dispose();
    if (output.length > 100_000) throw new Error("Calculation output is too large; return a summary");
    if (output === "undefined") throw new Error("Return a JSON-compatible calculation result");
    return JSON.parse(output) as unknown;
  } finally { vm.dispose(); runtime.dispose(); }
}

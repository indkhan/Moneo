import { getQuickJS, shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSHandle, type QuickJSRuntime } from "quickjs-emscripten";
import { LIMITS, type StartMessage } from "./contract";

let vm: QuickJSContext | undefined;
let runtime: QuickJSRuntime | undefined;
let start: StartMessage;
let localState: { slider: number };

function finish(result: ReturnType<QuickJSContext["evalCode"]> | ReturnType<QuickJSContext["callFunction"]>) {
  if (result.error) { const error = vm!.dump(result.error); result.error.dispose(); throw new Error(String(error?.message ?? error)); }
  result.value.dispose();
}

function object(values: Record<string, string | number>) {
  const result = vm!.newObject();
  for (const [key, value] of Object.entries(values)) {
    const handle = typeof value === "number" ? vm!.newNumber(value) : vm!.newString(value);
    vm!.setProp(result, key, handle); handle.dispose();
  }
  return result;
}

function publish(type: "render" | "patch", handle?: QuickJSHandle) {
  const value = handle && vm!.dump(handle);
  const valid = type === "render"
    ? value?.type === "chart" && Array.isArray(value.rows)
    : (typeof value?.slot === "string" && typeof value?.text === "string") || (value?.action === "scenario" && typeof value?.value === "string");
  if (!valid) throw new Error("invalid_sdk_message");
  postMessage({ type, value, protocol: start.protocol, nonce: start.nonce });
}

function installSdk(message: StartMessage) {
  localState = { slider: message.state.slider };
  const artifact = vm!.newObject(); const ui = vm!.newObject(); const state = vm!.newObject(); const finance = vm!.newObject();
  const render = vm!.newFunction("render", value => publish("render", value));
  const patch = vm!.newFunction("patch", value => publish("patch", value));
  const get = vm!.newFunction("get", () => object(localState));
  const set = vm!.newFunction("set", value => {
    const candidate = vm!.dump(value);
    if (!candidate || Object.keys(candidate).length !== 1 || !Number.isInteger(candidate.slider) || candidate.slider < 0 || candidate.slider > 100) throw new Error("invalid_state_patch");
    localState = { slider: candidate.slider };
    postMessage({ type: "state", value: localState, protocol: start.protocol, nonce: start.nonce });
  });
  const spending = vm!.newFunction("spendingByCategory", () => {
    const rows = vm!.newArray();
    message.finance.categories.forEach((row, index) => { const item = object(row); vm!.setProp(rows, index, item); item.dispose(); });
    return rows;
  });
  vm!.setProp(ui, "render", render); vm!.setProp(ui, "patch", patch);
  vm!.setProp(state, "get", get); vm!.setProp(state, "set", set);
  vm!.setProp(finance, "spendingByCategory", spending);
  vm!.setProp(artifact, "ui", ui); vm!.setProp(artifact, "state", state); vm!.setProp(artifact, "finance", finance);
  vm!.setProp(vm!.global, "artifact", artifact);
  [render, patch, get, set, spending, ui, state, finance, artifact].forEach(handle => handle.dispose());
  finish(vm!.evalCode("Object.freeze(artifact.ui); Object.freeze(artifact.state); Object.freeze(artifact.finance); Object.freeze(artifact); globalThis.eval=undefined; globalThis.Function=undefined"));
}

async function run(message: StartMessage) {
  start = message;
  const QuickJS = await getQuickJS();
  runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(LIMITS.heapBytes);
  runtime.setMaxStackSize(512 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + LIMITS.executionMs));
  vm = runtime.newContext();
  installSdk(message);
  finish(vm.evalCode(message.source.js, "artifact.js"));
  postMessage({ type: "status", value: "ready", protocol: message.protocol, nonce: message.nonce });
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "start") await run(data);
    else if (data.type === "event" && vm) {
      const handler = vm.getProp(vm.global, "onEvent"); const event = object(data.value);
      finish(vm.callFunction(handler, vm.undefined, event)); handler.dispose(); event.dispose();
      postMessage({ type: "status", value: "ready", protocol: start.protocol, nonce: start.nonce });
    }
  } catch (error) {
    postMessage({ type: "status", value: error instanceof Error && /interrupted/i.test(error.message) ? "terminated" : `rejected:${error instanceof Error ? error.message.slice(0, 200) : "runtime"}`, protocol: start?.protocol, nonce: start?.nonce });
  }
};

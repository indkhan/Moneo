import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";
import { LIMITS, type StartMessage } from "./contract";

let vm: ReturnType<Awaited<ReturnType<typeof getQuickJS>>["newContext"]> | undefined;
let runtime: ReturnType<Awaited<ReturnType<typeof getQuickJS>>["newRuntime"]> | undefined;
let start: StartMessage;

function dump(result: ReturnType<NonNullable<typeof vm>["evalCode"]>) {
  if (result.error) { const error = vm!.dump(result.error); result.error.dispose(); throw new Error(String(error?.message ?? error)); }
  result.value.dispose();
}

function drain() {
  const result = vm!.evalCode("JSON.stringify(globalThis.__outbox.splice(0))");
  if (result.error) { result.error.dispose(); return; }
  const messages = JSON.parse(vm!.getString(result.value)); result.value.dispose();
  for (const message of messages) postMessage(message);
}

async function run(message: StartMessage) {
  start = message;
  const QuickJS = await getQuickJS();
  runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(LIMITS.heapBytes);
  runtime.setMaxStackSize(512 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + LIMITS.executionMs));
  vm = runtime.newContext();
  const bootstrap = `
    globalThis.__outbox=[];
    const emit=(type,value)=>__outbox.push({type,value,protocol:${message.protocol},nonce:${JSON.stringify(message.nonce)}});
    const state=${JSON.stringify(message.state)};
    const finance=Object.freeze(${JSON.stringify(message.finance)});
    globalThis.artifact=Object.freeze({
      ui:Object.freeze({render:value=>emit("render",value),patch:value=>emit("patch",value)}),
      state:Object.freeze({get:()=>Object.freeze({...state}),set:value=>{Object.assign(state,value);emit("state",{...state})}}),
      finance:Object.freeze({spendingByCategory:()=>finance.categories.map(value=>Object.freeze({...value}))})
    });
    globalThis.eval=undefined; globalThis.Function=undefined;
  `;
  dump(vm.evalCode(`${bootstrap}\n${message.source.js}`, "artifact.js"));
  drain();
  postMessage({ type: "status", value: "ready", protocol: message.protocol, nonce: message.nonce });
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "start") await run(data);
    else if (data.type === "event" && vm) { dump(vm.evalCode(`onEvent(${JSON.stringify(data.value)})`)); drain(); postMessage({ type: "status", value: "ready", protocol: start.protocol, nonce: start.nonce }); }
  } catch (error) {
    postMessage({ type: "status", value: error instanceof Error && /interrupted/i.test(error.message) ? "terminated" : `rejected:${error instanceof Error ? error.message.slice(0, 200) : "runtime"}`, protocol: start?.protocol, nonce: start?.nonce });
  }
};

import { getQuickJS, shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSHandle, type QuickJSRuntime } from "quickjs-emscripten";
import { ARTIFACT_LIMITS, ARTIFACT_PROTOCOL, type StartMessage, type RuntimeMessage, type HostMessage, type ArtifactManifest } from "../../web/src/artifact-contract.ts";

let vm: QuickJSContext | undefined;
let runtime: QuickJSRuntime | undefined;
let startMessage: StartMessage;
let localState: Record<string, unknown> = {};
let messageCount = 0;
let windowStart = performance.now();
let executionTimer: ReturnType<typeof setTimeout> | undefined;

let sdkCallCount = 0;
let sdkCallWindowStart = performance.now();

const pendingRpcCalls = new Map<string, Array<{ resolve: (value: unknown) => void; reject: (reason: string) => void }>>();

function disposeHandle(handle: QuickJSHandle | undefined): void {
    try { handle?.dispose(); } catch { }
}

function createObject(values: Record<string, string | number | boolean | null | undefined>): QuickJSHandle {
    const result = vm!.newObject();
    for (const [key, value] of Object.entries(values)) {
        if (value === undefined) continue;
        let handle: QuickJSHandle;
        if (typeof value === "string") handle = vm!.newString(value);
        else if (typeof value === "number") handle = vm!.newNumber(value);
        else if (typeof value === "boolean") handle = vm!.newString(value ? "true" : "false");
        else handle = vm!.newString("null");
        vm!.setProp(result, key, handle);
        handle.dispose();
    }
    return result;
}

function validateSdkMessage(type: "render" | "patch", value: unknown): boolean {
    if (type === "render") {
        if (!value || typeof value !== "object") return false;
        const v = value as Record<string, unknown>;
        if (v.type !== "chart" || !Array.isArray(v.rows)) return false;
        for (const row of v.rows) {
            if (typeof row !== "object" || row === null) return false;
            const r = row as Record<string, unknown>;
            if (typeof r.label !== "string") return false;
            if (typeof r.amount !== "string" || !/^-?\d+\.\d{2}$/.test(r.amount)) return false;
        }
        return true;
    }
    if (type === "patch") {
        if (!value || typeof value !== "object") return false;
        const v = value as Record<string, unknown>;
        if (typeof v.slot === "string" && typeof v.text === "string") return true;
        if (v.action === "scenario" && typeof v.value === "string" && /^\d{1,3}$/.test(v.value)) return true;
        return false;
    }
    return false;
}

function publish(type: "render" | "patch", handle?: QuickJSHandle): void {
    const value = handle ? vm!.dump(handle) : undefined;
    if (!validateSdkMessage(type, value)) throw new Error("invalid_sdk_message");
    self.postMessage({ type, value, protocol: ARTIFACT_PROTOCOL, nonce: startMessage.nonce });
}

function publishState(state: Record<string, unknown>): void {
    self.postMessage({ type: "state", value: state, protocol: ARTIFACT_PROTOCOL, nonce: startMessage.nonce });
}

function publishStatus(status: string): void {
    self.postMessage({ type: "status", value: status, protocol: ARTIFACT_PROTOCOL, nonce: startMessage.nonce });
}

function publishRpcRequest(method: string, args: unknown, requestId: string): void {
    self.postMessage({ type: "rpc_request", value: { method, args, requestId }, protocol: ARTIFACT_PROTOCOL, nonce: startMessage.nonce });
}

function armExecutionLimit(): void {
    if (executionTimer) clearTimeout(executionTimer);
    executionTimer = setTimeout(() => terminateWorker("terminated"), ARTIFACT_LIMITS.executionMs);
}

function terminateWorker(status: string): void {
    if (executionTimer) clearTimeout(executionTimer);
    publishStatus(status);
    // Settle nothing: every pending callback pair was dup()ed and must be
    // released exactly once even though its result will never arrive. The
    // whole QuickJS heap is discarded with the runtime right after.
    for (const handlers of pendingRpcCalls.values()) {
        for (const h of handlers) {
            try {
                h.reject("terminated");
            } catch {
                // Release below still runs; rejection delivery is best-effort.
            }
        }
    }
    pendingRpcCalls.clear();
    vm = undefined; runtime = undefined; self.close();
}

function checkSdkCallRateLimit(): boolean {
    const now = performance.now();
    if (now - sdkCallWindowStart >= 60000) { sdkCallWindowStart = now; sdkCallCount = 0; }
    if (++sdkCallCount > ARTIFACT_LIMITS.maxSdkCallsPerMinute) return false;
    if (sdkCallCount > ARTIFACT_LIMITS.maxSdkCallsPerSession) return false;
    return true;
}

function installSdk(message: StartMessage): void {
    localState = { ...message.state };
    const artifact = vm!.newObject(), ui = vm!.newObject(), state = vm!.newObject(), finance = vm!.newObject();
    const render = vm!.newFunction("render", (v: QuickJSHandle) => publish("render", v));
    const patch = vm!.newFunction("patch", (v: QuickJSHandle) => publish("patch", v));
    const get = vm!.newFunction("get", () => createObject(localState as Record<string, string | number | boolean | null>));
    const set = vm!.newFunction("set", (v: QuickJSHandle) => {
        const c = vm!.dump(v);
        if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error("invalid_state_patch");
        if (Object.keys(c).length > ARTIFACT_LIMITS.maxStateKeys) throw new Error("state_key_limit");
        localState = { ...localState, ...c }; publishState(localState);
    });

    const createRpcFunction = (method: string) => vm!.newFunction(method, (argsHandle: QuickJSHandle) => {
        if (!checkSdkCallRateLimit()) throw new Error("sdk_call_rate_exceeded");
        const requestId = crypto.randomUUID();
        const args = vm!.dump(argsHandle);
        publishRpcRequest(method, args, requestId);
        // Thenable wired to THIS request: results arrive as JSON strings the
        // artifact code parses (nested results cannot cross as flat handles).
        // Native argument handles die with the call scope, so the callbacks
        // are dup()ed here and disposed exactly once when the RPC settles;
        // without the dup every finance call would never resolve
        // (QuickJSUseAfterFree swallowed by the settle guard).
        const thenable = vm!.newObject();
        const then = vm!.newFunction("then", (onFulfilled: QuickJSHandle, onRejected: QuickJSHandle | undefined) => {
            const keptFulfilled = onFulfilled.dup();
            const keptRejected = onRejected?.dup();
            const release = (): void => {
                disposeHandle(keptFulfilled);
                disposeHandle(keptRejected);
            };
            // Promise-like fan-out: every .then() registers without
            // orphaning earlier handlers; each dup()ed pair is released
            // exactly once when the RPC settles below.
            const handlers = pendingRpcCalls.get(requestId) ?? [];
            handlers.push({
                resolve: (val: unknown) => {
                    try {
                        vm!.callFunction(keptFulfilled, vm!.undefined, vm!.newString(JSON.stringify(val ?? null)));
                    } catch {
                        // VM gone or callback threw: the artifact run is over;
                        // the renderer surfaces the terminal status instead.
                    } finally {
                        release();
                    }
                },
                reject: (reason: string) => {
                    try {
                        if (keptRejected) vm!.callFunction(keptRejected, vm!.undefined, vm!.newString(String(reason)));
                    } catch {
                        // Same terminal-status path as a failed resolve.
                    } finally {
                        release();
                    }
                },
            });
            pendingRpcCalls.set(requestId, handlers);
        });
        vm!.setProp(thenable, "then", then);
        disposeHandle(then);
        return thenable;
    });

    const spendingByCategory = createRpcFunction("spendingByCategory");
    const cashflow = createRpcFunction("cashflow");
    const getBalances = createRpcFunction("getBalances");
    const transactionSummary = createRpcFunction("transactionSummary");

    vm!.setProp(ui, "render", render); vm!.setProp(ui, "patch", patch);
    vm!.setProp(state, "get", get); vm!.setProp(state, "set", set);
    vm!.setProp(finance, "spendingByCategory", spendingByCategory);
    vm!.setProp(finance, "cashflow", cashflow); vm!.setProp(finance, "getBalances", getBalances); vm!.setProp(finance, "transactionSummary", transactionSummary);
    vm!.setProp(artifact, "ui", ui); vm!.setProp(artifact, "state", state); vm!.setProp(artifact, "finance", finance); vm!.setProp(vm!.global, "artifact", artifact);
    [render, patch, get, set, spendingByCategory, cashflow, getBalances, transactionSummary, ui, state, finance, artifact].forEach(disposeHandle);

    vm!.evalCode(`Object.freeze(artifact.ui);Object.freeze(artifact.state);Object.freeze(artifact.finance);Object.freeze(artifact);globalThis.eval=undefined;globalThis.Function=undefined;globalThis.fetch=undefined;globalThis.XMLHttpRequest=undefined;globalThis.WebSocket=undefined;globalThis.navigator=undefined;globalThis.window=undefined;globalThis.document=undefined;globalThis.localStorage=undefined;globalThis.sessionStorage=undefined;globalThis.indexedDB=undefined;`);
}

async function run(message: StartMessage): Promise<void> {
    startMessage = message;
    const QuickJS = await getQuickJS();
    runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(ARTIFACT_LIMITS.heapBytes);
    runtime.setMaxStackSize(ARTIFACT_LIMITS.stackBytes);
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + ARTIFACT_LIMITS.executionMs));
    vm = runtime.newContext();
    installSdk(message);
    vm.evalCode(message.source.js, "artifact.js");
    publishStatus("ready");
}

function checkRateLimit(data: unknown): boolean {
    const now = performance.now();
    if (now - windowStart >= 1000) { windowStart = now; messageCount = 0; }
    if (++messageCount > ARTIFACT_LIMITS.messagesPerSecond) return false;
    if (new TextEncoder().encode(JSON.stringify(data)).byteLength > ARTIFACT_LIMITS.messageBytes) return false;
    return true;
}

self.onmessage = async (event: MessageEvent<HostMessage>) => {
    const data = event.data;
    try {
        if (data.type === "start") { await run(data); return; }
        if (!vm) return;
        if (!checkRateLimit(data) || data.protocol !== ARTIFACT_PROTOCOL || data.nonce !== startMessage.nonce) { terminateWorker("terminated"); return; }
        if (data.type === "event") {
            armExecutionLimit();
            const h = vm.getProp(vm.global, "onEvent"); const eo = createObject(data.value as Record<string, string | number | boolean | null>);
            try { vm.callFunction(h, vm.undefined, eo); } finally { disposeHandle(h); disposeHandle(eo); }
            publishStatus("ready");
        } else if (data.type === "stop") { terminateWorker("stopped"); }
        else if (data.type === "rpc_response") {
            const { requestId, result, error } = data.value as { requestId: string; result?: unknown; error?: string };
            const handlers = pendingRpcCalls.get(requestId);
            if (handlers) {
                pendingRpcCalls.delete(requestId);
                for (const h of handlers) {
                    if (error) h.reject(error);
                    else h.resolve(result);
                }
            }
        }
    } catch (e) { const m = e instanceof Error ? e.message.slice(0, 200) : "runtime"; publishStatus(/interrupted/i.test(m) ? "terminated" : `rejected:${m}`); }
};
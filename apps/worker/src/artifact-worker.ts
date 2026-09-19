import { getQuickJS, shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSHandle, type QuickJSRuntime } from "quickjs-emscripten";
import { ARTIFACT_LIMITS, ARTIFACT_PROTOCOL, type StartMessage, type RuntimeMessage, type HostMessage, type ArtifactManifest, RUNTIME_PERMISSIONS } from "../../web/src/artifact-contract.ts";

let vm: QuickJSContext | undefined;
let runtime: QuickJSRuntime | undefined;
let startMessage: StartMessage;
let localState: Record<string, unknown> = {};
let messageCount = 0;
let windowStart = performance.now();
let executionTimer: ReturnType<typeof setTimeout> | undefined;

function disposeHandle(handle: QuickJSHandle | undefined): void {
    try {
        handle?.dispose();
    } catch { /* ignore */ }
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
    if (!validateSdkMessage(type, value)) {
        throw new Error("invalid_sdk_message");
    }
    const msg: RuntimeMessage = { type, value, protocol: ARTIFACT_PROTOCOL, nonce: startMessage.nonce };
    self.postMessage(msg);
}

function publishState(state: Record<string, unknown>): void {
    const msg: RuntimeMessage = { type: "state", value: state, protocol: ARTIFACT_PROTOCOL, nonce: startMessage.nonce };
    self.postMessage(msg);
}

function publishStatus(status: string): void {
    const msg: RuntimeMessage = { type: "status", value: status, protocol: ARTIFACT_PROTOCOL, nonce: startMessage.nonce };
    self.postMessage(msg);
}

function armExecutionLimit(): void {
    if (executionTimer) clearTimeout(executionTimer);
    executionTimer = setTimeout(() => {
        terminateWorker("terminated");
    }, ARTIFACT_LIMITS.executionMs);
}

function terminateWorker(status: string): void {
    if (executionTimer) clearTimeout(executionTimer);
    publishStatus(status);
    vm = undefined;
    runtime = undefined;
    self.close();
}

function installSdk(message: StartMessage): void {
    localState = { ...message.state };
    const artifact = vm!.newObject();
    const ui = vm!.newObject();
    const state = vm!.newObject();
    const finance = vm!.newObject();

    const render = vm!.newFunction("render", (value: QuickJSHandle) => {
        publish("render", value);
    });
    const patch = vm!.newFunction("patch", (value: QuickJSHandle) => {
        publish("patch", value);
    });
    const get = vm!.newFunction("get", () => {
        return createObject(localState as Record<string, string | number | boolean | null>);
    });
    const set = vm!.newFunction("set", (value: QuickJSHandle) => {
        const candidate = vm!.dump(value);
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
            throw new Error("invalid_state_patch");
        }
        if (Object.keys(candidate).length > ARTIFACT_LIMITS.maxStateKeys) {
            throw new Error("state_key_limit");
        }
        localState = { ...localState, ...candidate };
        publishState(localState);
    });

    const spendingByCategory = vm!.newFunction("spendingByCategory", () => {
        const categories = message.finance.categories as Array<{ label: string; amount: string }> ?? [];
        const rows = vm!.newArray();
        categories.forEach((row, index) => {
            const item = createObject({ label: row.label, amount: row.amount });
            vm!.setProp(rows, index, item);
            disposeHandle(item);
        });
        return rows;
    });

    const cashflow = vm!.newFunction("cashflow", () => {
        const data = message.finance.cashflow as Array<{ date: string; inflow: string; outflow: string }> ?? [];
        const rows = vm!.newArray();
        data.forEach((row, index) => {
            const item = createObject({ date: row.date, inflow: row.inflow, outflow: row.outflow });
            vm!.setProp(rows, index, item);
            disposeHandle(item);
        });
        return rows;
    });

    const getBalances = vm!.newFunction("getBalances", () => {
        const data = message.finance.balances as Array<{ accountId: string; amount: string; currency: string }> ?? [];
        const rows = vm!.newArray();
        data.forEach((row, index) => {
            const item = createObject({ accountId: row.accountId, amount: row.amount, currency: row.currency });
            vm!.setProp(rows, index, item);
            disposeHandle(item);
        });
        return rows;
    });

    const transactionSummary = vm!.newFunction("transactionSummary", () => {
        const data = message.finance.transactionSummary as Array<{ date: string; amount: string; currency: string; direction: string; description: string }> ?? [];
        const rows = vm!.newArray();
        data.forEach((row, index) => {
            const item = createObject({ date: row.date, amount: row.amount, currency: row.currency, direction: row.direction, description: row.description });
            vm!.setProp(rows, index, item);
            disposeHandle(item);
        });
        return rows;
    });

    vm!.setProp(ui, "render", render);
    vm!.setProp(ui, "patch", patch);
    vm!.setProp(state, "get", get);
    vm!.setProp(state, "set", set);
    vm!.setProp(finance, "spendingByCategory", spendingByCategory);
    vm!.setProp(finance, "cashflow", cashflow);
    vm!.setProp(finance, "getBalances", getBalances);
    vm!.setProp(finance, "transactionSummary", transactionSummary);
    vm!.setProp(artifact, "ui", ui);
    vm!.setProp(artifact, "state", state);
    vm!.setProp(artifact, "finance", finance);
    vm!.setProp(vm!.global, "artifact", artifact);

    [render, patch, get, set, spendingByCategory, cashflow, getBalances, transactionSummary, ui, state, finance, artifact].forEach(disposeHandle);

    vm!.evalCode(`
        Object.freeze(artifact.ui);
        Object.freeze(artifact.state);
        Object.freeze(artifact.finance);
        Object.freeze(artifact);
        globalThis.eval = undefined;
        globalThis.Function = undefined;
        globalThis.fetch = undefined;
        globalThis.XMLHttpRequest = undefined;
        globalThis.WebSocket = undefined;
        globalThis.navigator = undefined;
        globalThis.window = undefined;
        globalThis.document = undefined;
        globalThis.localStorage = undefined;
        globalThis.sessionStorage = undefined;
        globalThis.indexedDB = undefined;
    `);
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
    if (now - windowStart >= 1000) {
        windowStart = now;
        messageCount = 0;
    }
    if (++messageCount > ARTIFACT_LIMITS.messagesPerSecond) return false;
    const byteSize = new TextEncoder().encode(JSON.stringify(data)).byteLength;
    if (byteSize > ARTIFACT_LIMITS.messageBytes) return false;
    return true;
}

self.onmessage = async (event: MessageEvent<HostMessage>) => {
    const data = event.data;
    try {
        if (data.type === "start") {
            await run(data);
            return;
        }
        if (!vm) return;

        if (!checkRateLimit(data) || data.protocol !== ARTIFACT_PROTOCOL || data.nonce !== startMessage.nonce) {
            terminateWorker("terminated");
            return;
        }

        if (data.type === "event") {
            armExecutionLimit();
            const handler = vm.getProp(vm.global, "onEvent");
            const eventObj = createObject(data.value as Record<string, string | number | boolean | null>);
            try {
                vm.callFunction(handler, vm.undefined, eventObj);
            } finally {
                disposeHandle(handler);
                disposeHandle(eventObj);
            }
            publishStatus("ready");
        } else if (data.type === "stop") {
            terminateWorker("stopped");
        }
    } catch (error) {
        const msg = error instanceof Error ? error.message.slice(0, 200) : "runtime";
        const status = /interrupted/i.test(msg) ? "terminated" : `rejected:${msg}`;
        publishStatus(status);
    }
};
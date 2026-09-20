import * as csstree from "css-tree";
import { ARTIFACT_LIMITS, ARTIFACT_PROTOCOL, RENDERER_ORIGIN, type ArtifactSource, type RuntimeMessage, type ArtifactManifest } from "./artifact-contract.ts";

const root = document.querySelector<HTMLElement>("#artifact-root")!;
const urlParams = new URLSearchParams(location.search);
const sessionId = urlParams.get("session") ?? "";
const nonce = sessionId;
let port: MessagePort;
let worker: Worker;
let executionTimer: ReturnType<typeof setTimeout>;
let messageCount = 0;
let windowStart = performance.now();

const allowedTags = new Set(["SECTION", "H1", "H2", "H3", "DIV", "LABEL", "INPUT", "OUTPUT", "BUTTON", "SELECT", "OPTION", "SPAN", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "UL", "OL", "LI", "P", "STRONG", "EM", "CODE", "PRE", "SVG", "CANVAS"]);
const allowedAttributes = new Set(["data-slot", "data-action", "type", "min", "max", "value", "placeholder", "disabled", "readonly", "role", "aria-label", "class", "style"]);
const allowedCss = new Set(["font", "padding", "color", "font-size", "width", "display", "align-items", "gap", "height", "background", "min-width", "max-width", "margin", "border", "border-radius", "box-sizing", "flex", "flex-direction", "justify-content", "overflow", "text-align", "line-height", "font-weight", "font-family", "cursor", "pointer-events", "transition", "transform", "opacity", "visibility", "position", "top", "left", "right", "bottom", "z-index"]);
const byteSize = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

const pendingRpcRequests = new Map<string, { resolve: (value: unknown) => void; reject: (reason: string) => void }>();

function sanitizeHtml(source: string): string {
    const doc = new DOMParser().parseFromString(source, "text/html");
    for (const element of [...doc.body.querySelectorAll("*")]) {
        if (!allowedTags.has(element.tagName)) {
            element.remove();
            continue;
        }
        for (const attribute of [...element.attributes]) {
            if (!allowedAttributes.has(attribute.name) || attribute.name.startsWith("on")) {
                element.removeAttribute(attribute.name);
            }
        }
        if (element.tagName === "INPUT" && element.getAttribute("type") !== "range" && element.getAttribute("type") !== "text" && element.getAttribute("type") !== "number" && element.getAttribute("type") !== "select") {
            element.remove();
        }
    }
    return doc.body.innerHTML;
}

function sanitizeCss(source: string): string {
    const ast = csstree.parse(source, { onParseError: () => { throw new Error("css_parse_error"); } });
    csstree.walk(ast, (node: csstree.CssNode) => {
        if (node.type === "Atrule" || node.type === "Url") {
            throw new Error("css_rejected");
        }
        if (node.type === "Declaration") {
            if (!allowedCss.has(node.property) || node.property.startsWith("--")) {
                throw new Error("css_rejected");
            }
        }
    });
    return csstree.generate(ast);
}

function checkRateLimit(data: { type: string; protocol: number; nonce: string; [key: string]: unknown }): boolean {
    const now = performance.now();
    if (now - windowStart >= 1000) {
        windowStart = now;
        messageCount = 0;
    }
    if (++messageCount > ARTIFACT_LIMITS.messagesPerSecond) return false;
    if (byteSize(data) > ARTIFACT_LIMITS.messageBytes) return false;
    if (data.protocol !== ARTIFACT_PROTOCOL || data.nonce !== nonce) return false;
    return true;
}

function stop(reason: string): void {
    clearTimeout(executionTimer);
    worker?.terminate();
    port?.postMessage({ type: "status", value: reason, protocol: ARTIFACT_PROTOCOL, nonce });
}

function armExecutionLimit(): void {
    clearTimeout(executionTimer);
    executionTimer = setTimeout(() => stop("terminated"), ARTIFACT_LIMITS.executionMs);
}

function renderChart(rows: Array<{ label: string; amount: string }>): HTMLElement {
    const chart = document.createElement("div");
    chart.className = "artifact-chart";
    chart.setAttribute("role", "img");
    chart.setAttribute("aria-label", "Chart");
    const bars = document.createElement("div");
    bars.className = "artifact-bars";
    bars.style.display = "flex";
    bars.style.alignItems = "flex-end";
    bars.style.gap = "0.5rem";
    bars.style.height = "9rem";
    for (const row of rows.slice(0, 20)) {
        if (typeof row.label !== "string" || !/^-?\d+\.\d{2}$/.test(row.amount)) continue;
        const bar = document.createElement("div");
        bar.className = "artifact-bar";
        const height = Math.min(100, Math.abs(Number(row.amount)) / 15);
        bar.style.height = `${height}%`;
        bar.style.flex = "1";
        bar.style.minWidth = "3rem";
        bar.style.background = "#5768ee";
        bar.style.borderRadius = "2px 2px 0 0";
        bar.textContent = row.label;
        bars.append(bar);
    }
    chart.append(bars);
    return chart;
}

function handleMessage(data: RuntimeMessage): void {
    if (data.type === "render" && data.value && typeof data.value === "object") {
        const v = data.value as { type?: string; rows?: unknown };
        if (v.type === "chart" && Array.isArray(v.rows)) {
            const slot = root.querySelector('[data-slot="chart"]');
            if (!slot) return;
            const chart = renderChart(v.rows as Array<{ label: string; amount: string }>);
            slot.replaceChildren(chart);
        }
    } else if (data.type === "patch" && data.value && typeof data.value === "object") {
        const v = data.value as { slot?: string; text?: string; action?: string; value?: string };
        if (typeof v.slot === "string" && typeof v.text === "string") {
            const el = root.querySelector(`[data-slot="${CSS.escape(v.slot)}"]`);
            if (el) el.replaceChildren(document.createTextNode(v.text.slice(0, 1000)));
        } else if (v.action === "scenario" && typeof v.value === "string" && /^\d{1,3}$/.test(v.value)) {
            const input = root.querySelector<HTMLInputElement>('[data-action="scenario"]');
            if (input) input.value = v.value;
        }
    } else if (data.type === "state") {
        port.postMessage(data);
    } else if (data.type === "status") {
        clearTimeout(executionTimer);
        port.postMessage(data);
    } else if (data.type === "rpc_response") {
        const { requestId, result, error } = data.value as { requestId: string; result?: unknown; error?: string };
        const pending = pendingRpcRequests.get(requestId);
        if (pending) {
            pendingRpcRequests.delete(requestId);
            if (error) {
                pending.reject(error);
            } else {
                pending.resolve(result);
            }
        }
    }
}

function sendRpcRequest(method: string, args: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID();
        pendingRpcRequests.set(requestId, { resolve, reject });
        port.postMessage({ type: "rpc_request", value: { method, args, requestId }, protocol: ARTIFACT_PROTOCOL, nonce });
        // Timeout after 30 seconds
        setTimeout(() => {
            if (pendingRpcRequests.has(requestId)) {
                pendingRpcRequests.delete(requestId);
                reject(new Error("rpc_timeout"));
            }
        }, 30000);
    });
}

window.addEventListener("message", (event) => {
    if (event.source !== parent || event.origin !== "http://localhost:4173" || event.data?.type !== "connect" || event.data?.protocol !== ARTIFACT_PROTOCOL || event.data?.nonce !== nonce || event.ports.length !== 1 || port) return;
    port = event.ports[0];
    port.onmessage = ({ data: reply }: { data: { type: "start" | "stop" | "rpc_response"; protocol: number; nonce: string; source?: ArtifactSource; state?: Record<string, unknown>; finance?: Record<string, unknown>; manifest?: ArtifactManifest; value?: { requestId: string; result?: unknown; error?: string } } }) => {
        if (!checkRateLimit(reply)) {
            stop("terminated");
            return;
        }
        if (reply.type === "stop") {
            stop("stopped");
            return;
        }
        if (reply.type === "rpc_response") {
            handleMessage(reply as RuntimeMessage);
            return;
        }
        if (reply.type !== "start") return;
        armExecutionLimit();
        const source = reply.source!;
        try {
            root.innerHTML = sanitizeHtml(source.html);
            const style = document.createElement("style");
            style.textContent = sanitizeCss(source.css);
            document.head.append(style);
            worker = new Worker("/artifact-worker.js", { type: "module" });
            worker.onmessage = ({ data: workerData }: { data: RuntimeMessage }) => {
                if (checkRateLimit(workerData)) {
                    if (workerData.type === "rpc_request") {
                        // Forward RPC request to host
                        const { method, args, requestId } = workerData.value as { method: string; args: unknown; requestId: string };
                        sendRpcRequest(method, args).then(
                            result => port.postMessage({ type: "rpc_response", value: { requestId, result }, protocol: ARTIFACT_PROTOCOL, nonce }),
                            error => port.postMessage({ type: "rpc_response", value: { requestId, error: error.message }, protocol: ARTIFACT_PROTOCOL, nonce })
                        );
                    } else {
                        handleMessage(workerData);
                    }
                }
            };
            worker.onerror = () => stop("rejected");
            worker.postMessage(reply);
            root.addEventListener("input", (e) => {
                const target = e.target as HTMLInputElement;
                if (target.dataset.action) {
                    armExecutionLimit();
                    worker.postMessage({ type: "event", value: { action: target.dataset.action, value: target.value }, protocol: ARTIFACT_PROTOCOL, nonce });
                }
            });
        } catch {
            stop("rejected");
        }
    };
});

parent.postMessage({ type: "ready", protocol: ARTIFACT_PROTOCOL, nonce }, "http://localhost:4173");
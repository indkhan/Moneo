import * as csstree from "css-tree";
import { LIMITS, PROTOCOL } from "./contract";

const root = document.querySelector<HTMLElement>("#root")!;
const nonce = location.hash.slice(1);
let port: MessagePort;
let worker: Worker;
let executionTimer = 0;
let count = 0;
let windowStart = performance.now();
const allowedTags = new Set(["SECTION", "H1", "DIV", "LABEL", "INPUT", "OUTPUT"]);
const allowedCss = new Set(["font", "padding", "color", "font-size", "width", "display", "align-items", "gap", "height", "background", "min-width"]);
const byteSize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

function sanitizeHtml(source: string) {
  const doc = new DOMParser().parseFromString(source, "text/html");
  for (const element of [...doc.body.querySelectorAll("*")]) {
    if (!allowedTags.has(element.tagName)) { element.remove(); continue; }
    for (const attribute of [...element.attributes]) {
      if (!new Set(["data-slot", "data-action", "type", "min", "max", "value"]).has(attribute.name) || attribute.name.startsWith("on")) element.removeAttribute(attribute.name);
    }
    if (element.tagName === "INPUT" && element.getAttribute("type") !== "range") element.remove();
  }
  return doc.body.innerHTML;
}

function sanitizeCss(source: string) {
  const ast = csstree.parse(source);
  csstree.walk(ast, node => {
    if (node.type === "Atrule" || node.type === "Url" || node.type === "Function" || node.type === "Raw" || (node.type === "Declaration" && (!allowedCss.has(node.property) || node.property.startsWith("--")))) throw new Error("css_rejected");
  });
  return csstree.generate(ast);
}

function accept(data: any) {
  const now = performance.now();
  if (now - windowStart >= 1000) { windowStart = now; count = 0; }
  if (++count > LIMITS.messagesPerSecond || byteSize(data) > LIMITS.messageBytes || data?.protocol !== PROTOCOL || data?.nonce !== nonce) { stop("terminated"); return false; }
  return true;
}

function stop(value: string) {
  clearTimeout(executionTimer);
  worker?.terminate();
  port?.postMessage({ type: "status", value, protocol: PROTOCOL, nonce });
}

function armExecutionLimit() {
  clearTimeout(executionTimer);
  executionTimer = window.setTimeout(() => stop("terminated"), LIMITS.executionMs);
}

function render(message: any) {
  if (message.type === "render" && message.value?.type === "chart" && Array.isArray(message.value.rows)) {
    const slot = root.querySelector('[data-slot="chart"]');
    if (!slot) return;
    const chart = document.createElement("div"); chart.className = "bars"; chart.setAttribute("role", "img"); chart.setAttribute("aria-label", "Spending by category");
    for (const row of message.value.rows.slice(0, 20)) {
      if (typeof row.label !== "string" || !/^\d+\.\d{2}$/.test(row.amount)) continue;
      const bar = document.createElement("div"); bar.className = "bar"; bar.style.height = `${Math.min(100, Number(row.amount) / 15)}%`; bar.textContent = row.label; chart.append(bar);
    }
    slot.replaceChildren(chart);
  } else if (message.type === "patch" && typeof message.value?.slot === "string" && typeof message.value?.text === "string") {
    root.querySelector(`[data-slot="${CSS.escape(message.value.slot)}"]`)?.replaceChildren(document.createTextNode(message.value.text.slice(0, 1000)));
  } else if (message.type === "patch" && message.value?.action === "scenario" && /^\d{1,3}$/.test(message.value?.value)) {
    const input = root.querySelector<HTMLInputElement>('[data-action="scenario"]'); if (input) input.value = message.value.value;
  } else if (message.type === "state") port.postMessage(message);
  else if (message.type === "status") { clearTimeout(executionTimer); port.postMessage(message); }
}

window.addEventListener("message", event => {
  if (event.source !== parent || event.origin !== "http://127.0.0.1:4173" || event.data?.type !== "connect" || event.data?.protocol !== PROTOCOL || event.data?.nonce !== nonce || event.ports.length !== 1 || port) return;
  port = event.ports[0];
  port.onmessage = ({ data }) => {
    if (!accept(data)) return;
    if (data.type === "stop") { stop("stopped"); return; }
    if (data.type !== "start") return;
    try {
      root.innerHTML = sanitizeHtml(data.source.html);
      const style = document.createElement("style"); style.textContent = sanitizeCss(data.source.css); document.head.append(style);
      worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = ({ data: reply }) => { if (accept(reply)) render(reply); };
      worker.onerror = () => stop("rejected");
      armExecutionLimit();
      worker.postMessage(data);
      root.addEventListener("input", event => {
        const target = event.target as HTMLInputElement;
        if (target.dataset.action) { armExecutionLimit(); worker.postMessage({ type: "event", value: { action: target.dataset.action, value: target.value } }); }
      });
    } catch { stop("rejected"); }
  };
});

parent.postMessage({ type: "ready", protocol: PROTOCOL, nonce }, "http://127.0.0.1:4173");

import { LIMITS, PROTOCOL, RENDERER_ORIGIN, type StartMessage } from "./contract";
import { sample } from "./sample";

const frame = document.querySelector<HTMLIFrameElement>("#artifact")!;
const status = document.querySelector<HTMLOutputElement>("#status")!;
let state = { version: 1, slider: 25 };
let activeSource = structuredClone(sample);
let port: MessagePort | undefined;
let nonce = "";

const byteSize = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength;

function open() {
  port?.close();
  if (byteSize(activeSource.html) + byteSize(activeSource.css) + byteSize(activeSource.js) > LIMITS.sourceBytes) { status.value = "source_limit"; return; }
  nonce = crypto.randomUUID();
  frame.src = `${RENDERER_ORIGIN}/renderer.html?session=${encodeURIComponent(nonce)}#${nonce}`;
  status.value = "loading";
}

window.addEventListener("message", event => {
  if (event.origin !== RENDERER_ORIGIN || event.source !== frame.contentWindow || event.data?.type !== "ready" || event.data?.protocol !== PROTOCOL || event.data?.nonce !== nonce) return;
  const channel = new MessageChannel();
  port = channel.port1;
  port.onmessage = ({ data }) => {
    if (byteSize(data) > LIMITS.messageBytes || data?.nonce !== nonce || data?.protocol !== PROTOCOL) return;
    if (data.type === "state" && Number.isInteger(data.value?.slider)) state = { ...state, ...data.value };
    if (data.type === "status") status.value = data.value;
  };
  const start: StartMessage = {
    type: "start", protocol: PROTOCOL, nonce, source: activeSource, state,
    finance: { categories: [{ label: "Housing", amount: "1200.00" }, { label: "Food", amount: "480.00" }] },
  };
  frame.contentWindow!.postMessage({ type: "connect", protocol: PROTOCOL, nonce }, RENDERER_ORIGIN, [channel.port2]);
  status.value = "connected";
  port.postMessage(start);
});

document.querySelector("#reload")!.addEventListener("click", open);
document.querySelector("#compact")!.addEventListener("click", () => { frame.width = "320"; frame.height = "240"; });
document.querySelector("#full")!.addEventListener("click", () => { frame.width = "800"; frame.height = "600"; });
document.querySelector("#stop")!.addEventListener("click", () => port?.postMessage({ type: "stop", protocol: PROTOCOL, nonce }));

Object.assign(window, {
  proof: {
    state: () => state,
    activate(source: typeof sample, migrate: (value: typeof state) => typeof state) {
      if (byteSize(source.html) + byteSize(source.css) + byteSize(source.js) > LIMITS.sourceBytes) throw new Error("source_limit");
      const previous = { source: activeSource, state };
      try { state = migrate(structuredClone(state)); activeSource = structuredClone(source); open(); return true; }
      catch { ({ source: activeSource, state } = previous); return false; }
    },
    hostile(js: string) { activeSource = { ...sample, js }; open(); },
  },
});

open();

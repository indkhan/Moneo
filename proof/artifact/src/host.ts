import { LIMITS, PROTOCOL, RENDERER_ORIGIN, type StartMessage } from "./contract";
import { sample } from "./sample";

const frame = document.querySelector<HTMLIFrameElement>("#artifact")!;
const status = document.querySelector<HTMLOutputElement>("#status")!;
let state = { version: 1, slider: 25 };
let activeSource = structuredClone(sample);
let port: MessagePort | undefined;
let nonce = "";
let session: { source: typeof sample; state: typeof state; candidate: boolean; resolve?: (accepted: boolean) => void };

const byteSize = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength;

function open(source = activeSource, initialState = state, candidate = false, resolve?: (accepted: boolean) => void) {
  port?.close();
  if (byteSize(source.html) + byteSize(source.css) + byteSize(source.js) > LIMITS.sourceBytes) { status.value = "source_limit"; resolve?.(false); return; }
  session = { source: structuredClone(source), state: structuredClone(initialState), candidate, resolve };
  nonce = crypto.randomUUID();
  frame.src = `${RENDERER_ORIGIN}/renderer.html?session=${encodeURIComponent(nonce)}#${nonce}`;
  status.value = "loading";
}

window.addEventListener("message", event => {
  if (event.origin !== RENDERER_ORIGIN || event.source !== frame.contentWindow || event.data?.type !== "ready" || event.data?.protocol !== PROTOCOL || event.data?.nonce !== nonce) return;
  const channel = new MessageChannel();
  const current = session;
  const currentNonce = nonce;
  port = channel.port1;
  port.onmessage = ({ data }) => {
    if (session !== current || byteSize(data) > LIMITS.messageBytes || data?.nonce !== currentNonce || data?.protocol !== PROTOCOL) return;
    if (data.type === "state" && data.value && Object.keys(data.value).length === 1 && Number.isInteger(data.value.slider) && data.value.slider >= 0 && data.value.slider <= 100) {
      current.state = { ...current.state, ...data.value };
      if (!current.candidate) state = current.state;
    }
    if (data.type === "status") {
      status.value = data.value;
      if (current.candidate && data.value === "ready") {
        activeSource = current.source; state = current.state; current.candidate = false; current.resolve?.(true); current.resolve = undefined;
      } else if (current.candidate && data.value !== "ready") {
        current.resolve?.(false); current.resolve = undefined; setTimeout(() => open(), 10);
      }
    }
  };
  const start: StartMessage = {
    type: "start", protocol: PROTOCOL, nonce, source: current.source, state: current.state,
    finance: { categories: [{ label: "Housing", amount: "1200.00" }, { label: "Food", amount: "480.00" }] },
  };
  frame.contentWindow!.postMessage({ type: "connect", protocol: PROTOCOL, nonce }, RENDERER_ORIGIN, [channel.port2]);
  status.value = "connected";
  port.postMessage(start);
});

document.querySelector("#reload")!.addEventListener("click", () => open());
document.querySelector("#compact")!.addEventListener("click", () => { frame.width = "320"; frame.height = "240"; });
document.querySelector("#full")!.addEventListener("click", () => { frame.width = "800"; frame.height = "600"; });
document.querySelector("#stop")!.addEventListener("click", () => port?.postMessage({ type: "stop", protocol: PROTOCOL, nonce }));

Object.assign(window, {
  proof: {
    state: () => state,
    activate(source: typeof sample, migrate: (value: typeof state) => typeof state) {
      try {
        const migrated = migrate(structuredClone(state));
        return new Promise<boolean>(resolve => open(source, migrated, true, resolve));
      } catch { return Promise.resolve(false); }
    },
    hostile(js: string) { open({ ...sample, js }); },
  },
});

open();

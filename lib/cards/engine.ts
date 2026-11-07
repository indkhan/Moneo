// Runs card code; loads on the server and, for a card with sliders or toggles, in the browser too.
import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline, type QuickJSWASMModule } from "quickjs-emscripten-core";
import releaseSync from "@jitl/quickjs-wasmfile-release-sync";

/** The element tree a card returns: plain data, never code. Our renderer turns it into React elements. */
export type CardNode = string | { type: string; props: Record<string, unknown>; children: CardNode[] };

// The card's code never sees the host: no imports, network, timers or storage. Elements are plain objects;
// Kit.X is just the name "kit:X", which our renderer maps to our own components.
const PRELUDE = `
const Fragment = "#fragment";
function flat(list, out) {
  for (const child of list) {
    if (Array.isArray(child)) flat(child, out);
    else if (child === null || child === undefined || child === false || child === true) continue;
    else if (typeof child === "object") out.push(child);
    else out.push(String(child));
  }
  return out;
}
function h(type, props, ...children) {
  const kids = flat(children, []);
  if (typeof type === "function") return type(Object.assign({}, props, { children: kids }));
  return { type: String(type), props: props || {}, children: kids };
}
const Kit = new Proxy({}, { get: (_, name) => "kit:" + String(name) });
const exports = {}; const module = { exports };
function require(name) { throw new Error("Cards cannot import modules (" + name + "); use Kit components."); }
`;

let quickjs: Promise<QuickJSWASMModule> | undefined;
const engine = () => quickjs ??= newQuickJSWASMModuleFromVariant(releaseSync);

// Not a design limit: they only stop a runaway loop or allocation from stalling Home.
const DEADLINE_MS = 1000;
const MEMORY_BYTES = 64 * 1024 * 1024;

/**
 * Runs a compiled card in a fresh QuickJS context and returns its element tree as JSON-safe data.
 * Every render gets its own runtime, so nothing leaks between cards or workspaces.
 */
export async function runCard(compiled: string, input: { data: unknown; params: Record<string, string | number | boolean>; size: string }): Promise<CardNode> {
  const runtime = (await engine()).newRuntime();
  runtime.setMemoryLimit(MEMORY_BYTES);
  runtime.setMaxStackSize(1024 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + DEADLINE_MS));
  const vm = runtime.newContext();
  try {
    const script = `${PRELUDE}\n${compiled}\n;(function () {
      const Card = module.exports.default || exports.default;
      if (typeof Card !== "function") throw new Error("The card must export a default function");
      return JSON.stringify(h(Card, JSON.parse(${JSON.stringify(JSON.stringify(input))})));
    })()`;
    const result = vm.evalCode(script, "card.js");
    if (result.error) {
      const error = vm.dump(result.error);
      result.error.dispose();
      throw new Error(`Card failed: ${typeof error === "object" && error ? (error.message ?? JSON.stringify(error)) : String(error)}`);
    }
    const json = vm.getString(result.value);
    result.value.dispose();
    return JSON.parse(json) as CardNode;
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}

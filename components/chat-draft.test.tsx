import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";
import { ChatForm } from "@/app/ai/chat-form";
import { AiPanelDialog } from "./ai-panel-dialog";
import { ChatComposer } from "./chat-composer";

const host = vi.hoisted(() => ({ index: 0, slots: [] as unknown[], effects: [] as (() => void)[], send: vi.fn() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = host.index++;
    if (!(index in host.slots)) host.slots[index] = typeof initial === "function" ? initial() : initial;
    return [host.slots[index], (next: unknown) => { host.slots[index] = typeof next === "function" ? next(host.slots[index]) : next; }];
  },
  useRef: (initial: unknown) => {
    const index = host.index++;
    if (!(index in host.slots)) host.slots[index] = { current: initial };
    return host.slots[index];
  },
  useEffect: (effect: () => void) => { host.effects.push(effect); },
  useCallback: (callback: unknown) => callback,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/money/transactions" }));
vi.mock("@/lib/ai/use-chat-request", () => ({ useChatRequest: () => ({ send: host.send, cancel: vi.fn(), busy: false, error: "", status: "idle" }) }));
vi.mock("@/lib/ai/selected-conversation", () => ({ selectConversation: vi.fn() }));
beforeEach(() => {
  host.index = 0; host.slots = []; host.effects = []; vi.clearAllMocks();
  vi.stubGlobal("window", { location: { pathname: "/money/transactions", search: "" } });
});
afterEach(() => vi.unstubAllGlobals());

type Props = { children?: ReactNode; value?: string; onChange?: (event: { target: { value: string } }) => void; onSubmit?: (event: { preventDefault: () => void }) => Promise<void> };
function find(node: ReactNode, type: string): Props | undefined {
  if (Array.isArray(node)) return node.map(child => find(child, type)).find(Boolean);
  if (!isValidElement<Props>(node)) return;
  // Expand the shared composer so its textarea and form are reachable.
  if (node.type === ChatComposer) return find(ChatComposer(node.props as unknown as Parameters<typeof ChatComposer>[0]), type);
  return node.type === type ? node.props : find(node.props.children, type);
}
const entryPoints = [
  ["conversation", () => ChatForm({ conversationId: "owned", selectionKey: "synthetic" })],
  ["panel", () => AiPanelDialog({ open: true, onClose: vi.fn() })],
] as const;

it.each(entryPoints)("%s preserves a next question typed while the submitted question is pending", async (_name, component) => {
  function render() { host.index = 0; return component(); }
  let settle!: (result: { answer: string }) => void;
  host.send.mockReturnValue(new Promise(resolve => { settle = resolve; }));
  find(render(), "textarea")!.onChange!({ target: { value: "Submitted question" } });
  const pending = find(render(), "form")!.onSubmit!({ preventDefault: vi.fn() });
  find(render(), "textarea")!.onChange!({ target: { value: "Next question draft" } });
  settle({ answer: "Completed answer" });
  await pending;
  expect(host.send.mock.calls[0][0]).toMatchObject({ message: "Submitted question" });
  expect(find(render(), "textarea")!.value).toBe("Next question draft");
});

it.each(entryPoints)("%s clears unchanged submitted text only after a successful response", async (_name, component) => {
  function render() { host.index = 0; return component(); }
  find(render(), "textarea")!.onChange!({ target: { value: "Submitted question" } });
  // The request hook returns null on failure or cancellation.
  host.send.mockResolvedValue(null);
  await find(render(), "form")!.onSubmit!({ preventDefault: vi.fn() });
  expect(find(render(), "textarea")!.value).toBe("Submitted question");
  host.send.mockResolvedValue({ answer: "Completed answer" });
  await find(render(), "form")!.onSubmit!({ preventDefault: vi.fn() });
  expect(find(render(), "textarea")!.value).toBe("");
});

it.each(entryPoints)("%s sends spoken words after the typed ones, marked as spoken", async (_name, component) => {
  function render() { host.index = 0; return component(); }
  type Voice = { voice?: { onSend: (text: string) => void } };
  const composer = (node: ReactNode): Voice | undefined => Array.isArray(node) ? node.map(composer).find(Boolean)
    : isValidElement<Voice & { children?: ReactNode }>(node) ? node.type === ChatComposer ? node.props : composer(node.props.children) : undefined;
  host.send.mockResolvedValue({ answer: "Proposed a cash expense" });
  find(render(), "textarea")!.onChange!({ target: { value: "Note:" } });
  composer(render())!.voice!.onSend("spent 12.40 cash at Netto");
  await Promise.resolve();
  expect(host.send.mock.calls[0][0]).toMatchObject({ message: "Note: spent 12.40 cash at Netto", context: { input: "voice" } });
  expect(find(render(), "textarea")!.value).toBe("");
});

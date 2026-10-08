"use client";

import { useMemo, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { z } from "zod";
import { chatContextSchema } from "@/lib/ai/conversation-context";

const preferencesSchema = z.object({ includeHistory: z.boolean().default(true), includePage: z.boolean().default(true), pinnedMessageIds: z.array(z.uuid()).max(8).default([]) }).strict();
const memory = new Map<string, string>();
const eventName = "moneo-ai-context-change";
const preferenceKey = (key: string, conversation: string) => `moneo-chat-context-${key}-${conversation}`;
const selectionKey = (key: string) => key.replace("moneo-conversation-", "moneo-ai-selection-");
function read(key: string) {
  if (!key) return null;
  if (memory.has(key)) return memory.get(key)!;
  try { return window.sessionStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: unknown) {
  if (!key) return;
  const text = JSON.stringify(value);
  memory.set(key, text);
  try { window.sessionStorage.setItem(key, text); } catch { /* Keep this tab's draft if storage is unavailable. */ }
  window.dispatchEvent(new Event(eventName));
}
function parse(value: string | null) {
  try { return value && value.length <= 2000 ? JSON.parse(value) : {}; } catch { return {}; }
}
function subscribe(listener: () => void) {
  window.addEventListener(eventName, listener);
  return () => window.removeEventListener(eventName, listener);
}
function usePreferences(key: string, conversation: string) {
  const storage = key ? preferenceKey(key, conversation) : "";
  const raw = useSyncExternalStore(subscribe, () => read(storage), () => null);
  const preferences = useMemo(() => preferencesSchema.safeParse(parse(raw)).data ?? preferencesSchema.parse({}), [raw]);
  const change = (next: Partial<z.infer<typeof preferencesSchema>>) => {
    const current = preferencesSchema.safeParse(parse(read(storage))).data ?? preferencesSchema.parse({});
    write(storage, { ...current, ...next });
  };
  return { preferences, change, bindConversation: (id: string) => write(preferenceKey(key, id), preferences) };
}
export function useChatContext(key: string, conversation: string) {
  const pathname = usePathname();
  const state = usePreferences(key, conversation);
  const storage = key ? selectionKey(key) : "";
  const raw = useSyncExternalStore(subscribe, () => read(storage), () => null);
  const selected = useMemo(() => chatContextSchema.safeParse(parse(raw)).data?.selected ?? [], [raw]);
  return { ...state, selected, pathname, removeSelection: () => write(storage, { selected: [] }),
    context: { includeHistory: state.preferences.includeHistory, pinnedMessageIds: state.preferences.pinnedMessageIds,
      ...(state.preferences.includePage ? { path: pathname } : {}), ...(selected.length ? { selected } : {}) } };
}
export function ChatContextControls({ state, disabled = false }: { state: ReturnType<typeof useChatContext>; disabled?: boolean }) {
  const { preferences, change } = state;
  return <section aria-label="Context for this request" className="my-4 rounded-lg border border-border p-3 text-xs">
    <h3 className="font-medium">Context for this request</h3>
    <p className="mt-1 text-muted-foreground">Earlier requests and permitted dialogue guide the discussion. Current financial facts are read again. Pin important requests in the conversation.</p>
    <div className="mt-2 flex flex-wrap gap-2">
      {preferences.includeHistory ? <button type="button" disabled={disabled} onClick={() => change({ includeHistory: false })} className="rounded border px-2 py-1">Remove earlier dialogue</button>
        : <button type="button" disabled={disabled} onClick={() => change({ includeHistory: true })} className="rounded border px-2 py-1">Include earlier dialogue</button>}
      {preferences.includePage ? <button type="button" disabled={disabled} onClick={() => change({ includePage: false })} className="rounded border px-2 py-1">Remove page context: {state.pathname}</button>
        : <button type="button" disabled={disabled} onClick={() => change({ includePage: true })} className="rounded border px-2 py-1">Include page context</button>}
      {state.selected.map(item => <button key={item.id} type="button" disabled={disabled} onClick={state.removeSelection} className="rounded border px-2 py-1">Remove transaction context: {item.id}</button>)}
      {preferences.pinnedMessageIds.map(id => <button key={id} type="button" disabled={disabled} onClick={() => change({ pinnedMessageIds: preferences.pinnedMessageIds.filter(value => value !== id) })} className="rounded border px-2 py-1">Remove pinned request: {id}</button>)}
    </div>
  </section>;
}
export function PinChatRequest({ selectionKey: key, conversationId, messageId, disabled = false }: { selectionKey: string; conversationId: string; messageId: string; disabled?: boolean }) {
  const { preferences, change } = usePreferences(key, conversationId);
  const pinned = preferences.pinnedMessageIds.includes(messageId);
  return <button type="button" aria-pressed={pinned} disabled={disabled || (!pinned && preferences.pinnedMessageIds.length >= 8)}
    onClick={() => change({ pinnedMessageIds: pinned ? preferences.pinnedMessageIds.filter(id => id !== messageId) : [...preferences.pinnedMessageIds, messageId] })}
    className="mt-2 text-xs underline">{pinned ? "Unpin request" : "Pin request"}</button>;
}
export function AttachTransactionToChat({ workspaceId, transactionId }: { workspaceId: string; transactionId: string }) {
  const key = `moneo-ai-selection-${workspaceId}`;
  const raw = useSyncExternalStore(subscribe, () => read(key), () => null);
  const attached = chatContextSchema.safeParse(parse(raw)).data?.selected?.some(item => item.id === transactionId) ?? false;
  return <div className="mt-3"><button type="button" aria-pressed={attached} onClick={() => write(key, { selected: [{ kind: "transaction", id: transactionId }] })} className="text-sm underline">Attach transaction to AI</button>
    {attached && <p role="status" className="mt-1 text-xs">Transaction attached. Open the assistant or AI workspace to review or remove it.</p>}</div>;
}

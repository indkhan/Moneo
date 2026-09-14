import { CSRF_HEADER } from "./csrf";
import type { FetchImpl } from "./sessions-client";

import type {
  AiEvidence,
  AiToolActivity,
  AiChatEvent,
  AiChatRequest,
  AiConversation,
  AiChatMessage,
} from "../generated/client";
export type Evidence = AiEvidence;
export type ToolActivity = AiToolActivity;
export type ChatEvent = AiChatEvent;
export type ChatRequest = AiChatRequest;

function chatError(message: string): Error {
  return new Error(message || "The assistant could not complete that request.");
}

function isEvent(value: unknown): value is ChatEvent {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const event = value as Record<string, unknown>;
  if (event.type === "conversation") return typeof event.conversationId === "string";
  if (event.type === "tool")
    return (
      typeof event.name === "string" &&
      typeof event.status === "string" &&
      ["running", "succeeded", "failed", "cancelled"].includes(event.status)
    );
  if (event.type === "text") return typeof event.text === "string";
  if (event.type === "done") return typeof event.runId === "string";
  if (event.type === "error") return typeof event.message === "string";
  if (event.type !== "evidence" || !event.evidence || typeof event.evidence !== "object")
    return false;
  const evidence = event.evidence as Record<string, unknown>;
  return (
    typeof evidence.id === "string" &&
    typeof evidence.label === "string" &&
    typeof evidence.href === "string" &&
    /^\/ai\/evidence\/[\w-]+$/.test(evidence.href)
  );
}

export async function consumeChatStream(
  fetchImpl: FetchImpl,
  csrfToken: string | undefined,
  request: ChatRequest,
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetchImpl("/api/v1/ai/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(csrfToken ? { [CSRF_HEADER]: csrfToken } : {}),
    },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok || !response.body) throw chatError("The assistant is unavailable. Try again.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let remaining = "";
  const status = { completed: false };
  const emit = (line: string) => {
    if (!line.trim()) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      throw chatError("invalid assistant response");
    }
    if (!isEvent(event)) throw chatError("invalid assistant response");
    onEvent(event);
    if (event.type === "done") status.completed = true;
    if (event.type === "error") throw chatError(event.message);
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      remaining += decoder.decode(chunk.value, { stream: true });
      const lines = remaining.split("\n");
      remaining = lines.pop() ?? "";
      lines.forEach(emit);
    }
    remaining += decoder.decode();
    emit(remaining);
    if (!status.completed) throw chatError("The assistant response was interrupted. Please retry.");
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export type ConversationSummary = AiConversation;
export type ChatMessage = AiChatMessage;

export async function listConversations(fetchImpl: FetchImpl): Promise<ConversationSummary[]> {
  const response = await fetchImpl("/api/v1/ai/conversations");
  const body = (await response.json().catch(() => null)) as { conversations?: unknown } | null;
  if (!response.ok || !body || !Array.isArray(body.conversations))
    throw chatError("Could not load conversations.");
  return body.conversations.filter(
    (value): value is ConversationSummary =>
      !!value &&
      typeof value === "object" &&
      typeof (value as ConversationSummary).id === "string" &&
      typeof (value as ConversationSummary).title === "string" &&
      typeof (value as ConversationSummary).updatedAt === "string",
  );
}

export async function getConversation(
  fetchImpl: FetchImpl,
  id: string,
): Promise<{ conversation: ConversationSummary; messages: ChatMessage[] }> {
  const response = await fetchImpl(`/api/v1/ai/conversations/${encodeURIComponent(id)}`);
  const body = (await response.json().catch(() => null)) as {
    conversation?: ConversationSummary;
    messages?: ChatMessage[];
  } | null;
  if (!response.ok || !body?.conversation || !Array.isArray(body.messages))
    throw chatError("Could not load this conversation.");
  return { conversation: body.conversation, messages: body.messages };
}

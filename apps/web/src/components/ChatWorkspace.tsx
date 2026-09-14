"use client";

import Link from "next/link";
import { Button } from "@moneo/ui";
import * as React from "react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import {
  consumeChatStream,
  getConversation,
  listConversations,
  type ChatMessage,
  type ConversationSummary,
  type Evidence,
  type ToolActivity,
} from "../lib/ai-client";
import { readCsrfToken } from "../lib/sessions-client";

type Context = { pathname: string; label?: string };
type Props = { compact: boolean; initialContext?: Context };

function ToolActivityView({ items }: { items: ToolActivity[] }) {
  if (!items.length) return null;
  return (
    <details style={{ fontSize: 13, color: "var(--moneo-muted)" }}>
      <summary>
        {items.length} action{items.length === 1 ? "" : "s"} · View activity
      </summary>
      <ul>
        {items.map((item, index) => (
          <li key={`${item.name}-${index}`}>
            {item.status === "succeeded" ? "✓" : "•"} {item.name}
          </li>
        ))}
      </ul>
    </details>
  );
}

function EvidenceCards({ evidence }: { evidence: Evidence[] }) {
  if (!evidence.length) return null;
  return (
    <div aria-label="Evidence" style={{ display: "grid", gap: 6, marginTop: 8 }}>
      {evidence.map((item) => (
        <Link
          key={item.id}
          href={item.href || `/ai/evidence/${item.id}`}
          style={{
            padding: 8,
            border: "1px solid var(--moneo-border)",
            borderRadius: 6,
            textDecoration: "none",
            fontSize: 13,
          }}
        >
          Evidence · {item.label}
        </Link>
      ))}
    </div>
  );
}

function useChatState(initialContext?: Context) {
  const [threads, setThreads] = useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [context, setContext] = useState<Context | undefined>(initialContext);
  const [pinned, setPinned] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [retryMessage, setRetryMessage] = useState<string>();
  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    if (!pinned) setContext(initialContext);
  }, [initialContext, pinned]);

  const loadThreads = async () => {
    setLoading(true);
    setError(undefined);
    try {
      setThreads(await listConversations(globalThis.fetch));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load conversations.");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void loadThreads();
  }, []);

  const selectThread = async (id: string) => {
    setConversationId(id);
    setError(undefined);
    setLoading(true);
    try {
      const result = await getConversation(globalThis.fetch, id);
      setMessages(result.messages);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load this conversation.");
    } finally {
      setLoading(false);
    }
  };
  const send = async (retryText?: string) => {
    const text = (retryText ?? draft).trim();
    if (!text || running) return;
    setRetryMessage(undefined);
    setDraft("");
    setError(undefined);
    setRunning(true);
    const userMessage: ChatMessage = {
      id: `local-user-${Date.now()}`,
      role: "user",
      content: text,
    };
    const assistantId = `local-assistant-${Date.now()}`;
    setMessages((current) => [
      ...current,
      userMessage,
      { id: assistantId, role: "assistant", content: "", evidence: [], toolActivity: [] },
    ]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await consumeChatStream(
        globalThis.fetch,
        readCsrfToken(document.cookie),
        {
          message: text,
          ...(conversationId ? { conversationId } : {}),
          ...(context ? { context } : {}),
        },
        (event) => {
          if (event.type === "conversation") setConversationId(event.conversationId);
          if (event.type === "text")
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId
                  ? { ...message, content: message.content + event.text }
                  : message,
              ),
            );
          if (event.type === "tool")
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId
                  ? {
                      ...message,
                      toolActivity: [
                        ...(message.toolActivity ?? []).filter((item) => item.name !== event.name),
                        { name: event.name, status: event.status },
                      ],
                    }
                  : message,
              ),
            );
          if (event.type === "evidence")
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId
                  ? { ...message, evidence: [...(message.evidence ?? []), event.evidence] }
                  : message,
              ),
            );
        },
        controller.signal,
      );
      void loadThreads();
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(
          cause instanceof Error ? cause.message : "The assistant could not complete that request.",
        );
        setDraft(text);
        setRetryMessage(text);
      }
    } finally {
      setRunning(false);
      abortRef.current = undefined;
    }
  };
  const newConversation = () => {
    abortRef.current?.abort();
    setConversationId(undefined);
    setMessages([]);
    setError(undefined);
    setRetryMessage(undefined);
  };
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );
  return {
    threads,
    conversationId,
    messages,
    draft,
    setDraft,
    context,
    setContext,
    pinned,
    setPinned,
    loading,
    error,
    running,
    abortRef,
    loadThreads,
    selectThread,
    send,
    newConversation,
    retryMessage,
  };
}
const SharedChat = createContext<ReturnType<typeof useChatState> | null>(null);
export function ChatProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const context = useMemo(
    () => ({
      pathname: pathname || "/home",
      label: (pathname || "/home").slice(1).replaceAll("/", " / "),
    }),
    [pathname],
  );
  const state = useChatState(context);
  return <SharedChat.Provider value={state}>{children}</SharedChat.Provider>;
}
function StandaloneChat(props: Props) {
  const state = useChatState(props.initialContext);
  return <ChatView {...props} state={state} />;
}
export function ChatWorkspace(props: Props) {
  const state = useContext(SharedChat);
  return state ? <ChatView {...props} state={state} /> : <StandaloneChat {...props} />;
}
function ChatView({ compact, state }: Props & { state: ReturnType<typeof useChatState> }) {
  const {
    threads,
    conversationId,
    messages,
    draft,
    setDraft,
    context,
    setContext,
    pinned,
    setPinned,
    loading,
    error,
    running,
    abortRef,
    loadThreads,
    selectThread,
    send,
    newConversation,
    retryMessage,
  } = state;
  const title = compact ? "Assistant" : "Finance assistant";

  return (
    <section
      aria-label="Assistant conversation"
      className="finance-controls"
      style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", minHeight: 0 }}
    >
      <div
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
      >
        <strong>{title}</strong>
        {compact ? <Link href="/ai">Open full chat</Link> : null}
      </div>
      {context ? (
        <div
          aria-label="Conversation context"
          style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}
        >
          <span
            style={{
              border: "1px solid var(--moneo-border)",
              padding: "4px 8px",
              borderRadius: 999,
              fontSize: 12,
            }}
          >
            {context.label ?? context.pathname}
          </span>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            aria-label={`Remove ${context.label ?? context.pathname} context`}
            onClick={() => {
              setContext(undefined);
              setPinned(false);
            }}
          >
            Remove
          </Button>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            aria-pressed={pinned}
            onClick={() => {
              setPinned((value) => !value);
            }}
          >
            {pinned ? "Pinned" : "Pin context"}
          </Button>
        </div>
      ) : null}
      {!compact ? (
        <div style={{ display: "grid", gap: 4 }}>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={running}
            onClick={newConversation}
          >
            New conversation
          </Button>
          {loading ? (
            <p aria-label="Loading conversations">Loading conversations…</p>
          ) : (
            threads.map((thread) => (
              <Button
                variant="secondary"
                size="sm"
                key={thread.id}
                type="button"
                disabled={running}
                onClick={() => void selectThread(thread.id)}
                aria-pressed={thread.id === conversationId}
                style={{ textAlign: "left" }}
              >
                {thread.title}
              </Button>
            ))
          )}
        </div>
      ) : null}
      {error ? (
        <div role="alert">
          {error}{" "}
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={running}
            onClick={() =>
              void (retryMessage
                ? send(retryMessage)
                : conversationId
                  ? selectThread(conversationId)
                  : loadThreads())
            }
          >
            Retry
          </Button>
        </div>
      ) : null}
      <div
        aria-live="polite"
        style={{
          display: "grid",
          alignContent: "start",
          gap: 10,
          overflow: "auto",
          flex: 1,
          minHeight: 120,
        }}
      >
        {messages.length === 0 && !loading ? (
          <p>Ask about your finances to start a conversation.</p>
        ) : (
          messages.map((message) => (
            <article
              key={message.id}
              style={{
                padding: 10,
                borderRadius: 8,
                background: message.role === "user" ? "var(--moneo-surface)" : "transparent",
                border: "1px solid var(--moneo-border)",
              }}
            >
              <strong>{message.role === "user" ? "You" : "Assistant"}</strong>
              <div style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>
                {message.content || (running ? "Working…" : "")}
              </div>
              <ToolActivityView items={message.toolActivity ?? []} />
              <EvidenceCards evidence={message.evidence ?? []} />
            </article>
          ))
        )}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        style={{ display: "grid", gap: 8 }}
      >
        <label htmlFor={compact ? "panel-ai-message" : "ai-message"}>Ask about your finances</label>
        <textarea
          id={compact ? "panel-ai-message" : "ai-message"}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          rows={compact ? 2 : 3}
          disabled={running}
        />
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant="secondary" size="sm" type="submit" disabled={!draft.trim() || running}>
            Send
          </Button>
          {running ? (
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => {
                abortRef.current?.abort();
              }}
            >
              Stop
            </Button>
          ) : null}
        </div>
      </form>
    </section>
  );
}

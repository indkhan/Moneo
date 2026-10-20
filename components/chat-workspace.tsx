"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Check, Menu, Pencil, Plus, Search, Sparkles, Trash2, X } from "lucide-react";
import { ChatForm } from "@/app/ai/chat-form";
import { ChatMessages, applyChatEvent, type ChatItem, type PendingExchange } from "./chat-messages";
import { ConversationSelection } from "@/lib/ai/selected-conversation";
import type { HistoryThread } from "@/lib/ai/conversation-history";
import type { ChatAnswer, ChatStreamEvent } from "@/lib/ai/use-chat-request";

// Only fetched once someone opens the deep review popover.
const AnalysisPanel = dynamic(() => import("@/app/ai/analysis-panel").then(module => module.AnalysisPanel), {
  ssr: false, loading: () => <p role="status" className="p-6 text-sm text-muted-foreground">Loading review options…</p>,
});

type Entry = { conversation: HistoryThread; messages: ChatItem[]; cursor: string | null };
type ChatWorkspaceInitial = { threads: HistoryThread[]; threadsCursor: string | null; selected: HistoryThread | null; messages: ChatItem[]; messagesCursor: string | null };

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { cache: "no-store", ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? "Request failed. Try again.");
  return body as T;
}
const seed = (initial: ChatWorkspaceInitial): Record<string, Entry> => initial.selected ? { [initial.selected.id]: { conversation: initial.selected, messages: initial.messages, cursor: initial.messagesCursor } } : {};
function omit<T>(record: Record<string, T>, key: string) { const next = { ...record }; delete next[key]; return next; }
const href = (id: string) => `/ai?conversation=${id}`;

/** Client-side chat workspace: switching, paging, search, rename and delete never re-render the server page. */
export function ChatWorkspace({ initial, newConversationId, selectionKey, locale, timezone, scope }: { initial: ChatWorkspaceInitial; newConversationId: string; selectionKey: string; locale: string; timezone: string; scope: React.ReactNode }) {
  const [seen, setSeen] = useState(initial);
  const [threads, setThreads] = useState(initial.threads);
  const [threadsCursor, setThreadsCursor] = useState(initial.threadsCursor);
  const [entries, setEntries] = useState(() => seed(initial));
  // A server re-render (for example after the panel starts a chat) refreshes the cached view.
  if (seen !== initial) { setSeen(initial); setThreads(initial.threads); setThreadsCursor(initial.threadsCursor); setEntries(current => ({ ...current, ...seed(initial) })); }
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, PendingExchange>>({});
  const [draftId, setDraftId] = useState(newConversationId);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<HistoryThread[] | null>(null);
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const loading = useRef(new Set<string>());
  const menu = useRef<HTMLDetailsElement>(null);
  const end = useRef<HTMLDivElement>(null);

  const param = useSearchParams().get("conversation");
  const selectedId = param === "new" ? null : param ?? initial.selected?.id ?? null;
  const activeId = selectedId ?? draftId;
  const entry = entries[activeId];
  const active = pending[activeId];

  function load(id: string) {
    if (entries[id] || errors[id] || loading.current.has(id)) return;
    loading.current.add(id);
    json<{ selected: HistoryThread; messages: ChatItem[]; messagesCursor: string | null }>(`/api/conversations/${id}`)
      .then(data => { setEntries(current => current[id] ? current : { ...current, [id]: { conversation: data.selected, messages: data.messages, cursor: data.messagesCursor } }); setErrors(current => omit(current, id)); })
      .catch(cause => setErrors(current => ({ ...current, [id]: cause.message })))
      .finally(() => loading.current.delete(id));
  }
  const latest = useRef({ selectedId, draftId });
  useEffect(() => { latest.current = { selectedId, draftId }; if (selectedId) load(selectedId); }); // load() skips cached and in-flight chats
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [activeId, entry?.messages.length, active]);

  // Debounced search over titles and message text.
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const controller = new AbortController();
    const timer = setTimeout(() => json<{ threads: HistoryThread[] }>(`/api/conversations?${new URLSearchParams({ view: "threads", q })}`, { signal: controller.signal })
      .then(data => setResults(data.threads)).catch(cause => { if (!controller.signal.aborted) setNotice(cause.message); }), 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);

  function open(event: React.MouseEvent, id: string | null) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    if (menu.current) menu.current.open = false;
    if (id === null) { if (entries[draftId] || pending[draftId]) setDraftId(crypto.randomUUID()); window.history.pushState(null, "", href("new")); return; }
    load(id);
    if (id !== selectedId) window.history.pushState(null, "", href(id));
  }

  async function olderThreads() {
    if (!threadsCursor) return;
    setBusy(true);
    try {
      const data = await json<{ threads: HistoryThread[]; threadsCursor: string | null }>(`/api/conversations?${new URLSearchParams({ view: "threads", threadsBefore: threadsCursor })}`);
      setThreads(current => [...current, ...data.threads.filter(thread => !current.some(item => item.id === thread.id))]);
      setThreadsCursor(data.threadsCursor);
    } catch (cause) { setNotice((cause as Error).message); } finally { setBusy(false); }
  }

  async function olderMessages() {
    if (!entry?.cursor) return;
    const id = activeId, cursor = entry.cursor;
    setBusy(true);
    try {
      const data = await json<{ messages: ChatItem[]; messagesCursor: string | null }>(`/api/conversations/${id}?${new URLSearchParams({ messagesBefore: cursor })}`);
      setEntries(current => current[id] ? { ...current, [id]: { ...current[id], messages: [...data.messages, ...current[id].messages], cursor: data.messagesCursor } } : current);
    } catch (cause) { setNotice((cause as Error).message); } finally { setBusy(false); }
  }

  function retitle(id: string, title: string) {
    const rename = (list: HistoryThread[]) => list.map(thread => thread.id === id ? { ...thread, title } : thread);
    setThreads(rename); setResults(current => current && rename(current));
    setEntries(current => current[id] ? { ...current, [id]: { ...current[id], conversation: { ...current[id].conversation, title } } } : current);
  }
  async function rename(event: React.FormEvent<HTMLFormElement>, thread: HistoryThread) {
    event.preventDefault();
    const title = String(new FormData(event.currentTarget).get("title") ?? "").trim();
    setEditing(null);
    if (!title || title === thread.title) return;
    retitle(thread.id, title);
    try { await json(`/api/conversations/${thread.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) }); }
    catch (cause) { retitle(thread.id, thread.title); setNotice((cause as Error).message); }
  }
  async function remove(thread: HistoryThread) {
    if (!window.confirm(`Delete “${thread.title}”? It will no longer appear in your chats. Edits it made stay in transaction history.`)) return;
    try {
      await json(`/api/conversations/${thread.id}`, { method: "DELETE" });
      const keep = (list: HistoryThread[]) => list.filter(item => item.id !== thread.id);
      setThreads(keep); setResults(current => current && keep(current));
      setEntries(current => omit(current, thread.id));
      if (thread.id === selectedId) window.history.pushState(null, "", href("new"));
    } catch (cause) { setNotice((cause as Error).message); }
  }

  // Mirrors each pending exchange so the finished answer can keep its plan and tool calls.
  const live = useRef<Record<string, PendingExchange>>({});
  function onStart(id: string, question: string) { live.current[id] = { question, tools: [] }; setPending(current => ({ ...current, [id]: live.current[id] })); }
  function onEvent(id: string, event: ChatStreamEvent) {
    if (!live.current[id]) return;
    const next = live.current[id] = applyChatEvent(live.current[id], event);
    setPending(current => current[id] ? { ...current, [id]: next } : current);
  }
  function onDone(id: string, question: string, result: ChatAnswer | null) {
    const finished = live.current[id];
    delete live.current[id];
    setPending(current => omit(current, id));
    if (!result) return;
    const now = new Date().toISOString();
    const conversation = { id, title: question.trim().slice(0, 80), created_at: now };
    const exchange: ChatItem[] = [
      { id: `local-${crypto.randomUUID()}`, role: "user", content: question.trim(), created_at: now },
      { id: `local-${crypto.randomUUID()}`, role: "assistant", content: result.answer, created_at: now, tools: finished?.tools.length ? finished.tools : result.toolsUsed, plan: finished?.plan, followUps: result.followUps },
    ];
    setEntries(current => ({ ...current, [id]: current[id] ? { ...current[id], messages: [...current[id].messages, ...exchange] } : { conversation, messages: exchange, cursor: null } }));
    setThreads(current => current.some(thread => thread.id === id) ? current : [conversation, ...current]);
    // The first answer saves a new chat: give it its own URL without remounting the composer.
    if (latest.current.selectedId === null && latest.current.draftId === id) window.history.replaceState(null, "", href(id));
  }

  const title = entry?.conversation.title ?? threads.find(thread => thread.id === selectedId)?.title ?? (selectedId ? "" : "New chat");
  const list = results ?? threads;
  const sidebar = (prefix: string) => <>
    <Link href={href("new")} onClick={event => open(event, null)} className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-muted"><Plus className="size-4" aria-hidden="true" />New chat</Link>
    <label className="relative mt-3 block"><span className="sr-only">Search chats</span><Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" aria-hidden="true" />
      <input id={`${prefix}-search`} type="search" value={query} onChange={event => { setQuery(event.target.value); if (!event.target.value.trim()) setResults(null); }} maxLength={100} placeholder="Search chats" className="w-full rounded-lg border border-border bg-background py-2 pr-2 pl-8 text-sm focus:border-muted-foreground/40 focus:outline-none" /></label>
    <nav aria-label="Conversations" className="mt-3 space-y-0.5">
      {results && !results.length && <p className="px-3 py-2 text-sm text-muted-foreground">No chats match “{query.trim()}”.</p>}
      {list.map(thread => editing === thread.id
        ? <form key={thread.id} onSubmit={event => void rename(event, thread)} className="flex items-center gap-1 px-1 py-0.5">
          <label className="sr-only" htmlFor={`${prefix}-rename-${thread.id}`}>Chat title</label>
          <input id={`${prefix}-rename-${thread.id}`} name="title" defaultValue={thread.title} maxLength={120} autoFocus required onKeyDown={event => { if (event.key === "Escape") setEditing(null); }} className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
          <button aria-label="Save title" className="rounded-md p-1.5 hover:bg-muted"><Check className="size-4" aria-hidden="true" /></button>
          <button type="button" aria-label="Cancel rename" onClick={() => setEditing(null)} className="rounded-md p-1.5 hover:bg-muted"><X className="size-4" aria-hidden="true" /></button>
        </form>
        : <div key={thread.id} className={`group flex items-center rounded-lg ${selectedId === thread.id ? "bg-muted" : "hover:bg-muted"}`}>
          <Link href={href(thread.id)} prefetch={false} onClick={event => open(event, thread.id)} onPointerEnter={() => load(thread.id)} onFocus={() => load(thread.id)} aria-current={selectedId === thread.id ? "page" : undefined}
            className={`min-w-0 flex-1 truncate px-3 py-2 text-sm ${selectedId === thread.id ? "font-medium text-foreground" : "text-muted-foreground group-hover:text-foreground"}`}>{thread.title}{pending[thread.id] && <span className="sr-only"> (answering)</span>}</Link>
          <span className="flex shrink-0 pr-1 lg:opacity-0 lg:group-focus-within:opacity-100 lg:group-hover:opacity-100">
            <button type="button" onClick={() => setEditing(thread.id)} aria-label={`Rename ${thread.title}`} className="rounded-md p-1.5 text-muted-foreground hover:text-foreground"><Pencil className="size-3.5" aria-hidden="true" /></button>
            <button type="button" onClick={() => void remove(thread)} aria-label={`Delete ${thread.title}`} className="rounded-md p-1.5 text-muted-foreground hover:text-red-600"><Trash2 className="size-3.5" aria-hidden="true" /></button>
          </span>
        </div>)}
    </nav>
    {!results && threadsCursor && <button type="button" disabled={busy} onClick={() => void olderThreads()} className="mt-2 block px-3 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50">Older conversations</button>}
    <div className="mt-6 space-y-0.5 border-t border-border pt-4 text-sm text-muted-foreground">
      <Link href="/ai/library" className="block rounded-lg px-3 py-2 hover:bg-muted hover:text-foreground">Saved tools and analyses</Link>
      <Link href="/ai/activity" className="block rounded-lg px-3 py-2 hover:bg-muted hover:text-foreground">Activity</Link>
      <Link href="/notifications" className="block rounded-lg px-3 py-2 hover:bg-muted hover:text-foreground">Notifications</Link>
    </div>
  </>;
  const summary = "flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground [&::-webkit-details-marker]:hidden";
  const empty = !entry?.messages.length && !active;
  const unavailable = selectedId && !entry ? errors[selectedId] : undefined;

  return <main className="flex min-h-[calc(100dvh-3.5rem)]">
    <ConversationSelection selectionKey={selectionKey} id={selectedId ?? "new"} />
    <aside className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-64 shrink-0 overflow-y-auto border-r border-border bg-card/60 p-3 lg:block">{sidebar("desktop")}</aside>
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="relative flex items-center gap-2 px-4 py-2.5">
        <details ref={menu} className="lg:hidden"><summary className={summary} aria-label="Show conversations"><Menu className="size-4" aria-hidden="true" /></summary><div className="absolute inset-x-4 top-full z-20 max-h-[70dvh] overflow-y-auto rounded-2xl border border-border bg-card p-3 shadow-lg">{sidebar("mobile")}</div></details>
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h1>
        <details onToggle={event => { if (event.currentTarget.open) setReviewOpen(true); }}><summary className={summary}><Sparkles className="size-4" aria-hidden="true" />Run a deep review</summary><div className="absolute inset-x-4 top-full z-20 mx-auto max-h-[75dvh] max-w-3xl overflow-y-auto rounded-2xl border border-border bg-card shadow-lg">{reviewOpen && <AnalysisPanel locale={locale} timezone={timezone} />}</div></details>
      </div>
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4">
        {notice && <p role="alert" className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm">{notice}<button type="button" onClick={() => setNotice("")} aria-label="Dismiss" className="text-muted-foreground hover:text-foreground"><X className="size-4" aria-hidden="true" /></button></p>}
        {unavailable ? <div className="py-10"><h2 className="font-semibold">Conversation unavailable</h2><p role="alert" className="mt-1 text-sm">{unavailable}</p><Link href={href("new")} onClick={event => open(event, null)} className="mt-3 inline-block text-sm underline">New conversation</Link></div>
          : selectedId && !entry ? <div className="space-y-6 py-6" role="status" aria-label="Loading conversation">{[0, 1].map(row => <div key={row} className="space-y-3"><div className="ml-auto h-9 w-1/2 animate-pulse rounded-3xl bg-muted" /><div className="h-4 w-5/6 animate-pulse rounded bg-muted" /><div className="h-4 w-2/3 animate-pulse rounded bg-muted" /></div>)}</div>
          : <>
            {entry?.cursor && <button type="button" disabled={busy} onClick={() => void olderMessages()} className="mt-2 self-center text-sm text-muted-foreground hover:text-foreground disabled:opacity-50">Older messages</button>}
            {!empty && <div className="py-6"><ChatMessages messages={entry?.messages ?? []} pending={active} /></div>}
            <ChatForm key={activeId} conversationId={activeId} selectionKey={selectionKey} empty={empty} scope={scope} onStart={onStart} onEvent={onEvent} onDone={onDone} />
          </>}
        <div ref={end} />
      </div>
    </section>
  </main>;
}

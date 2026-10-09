import Link from "next/link";
import { ConversationSelection } from "@/lib/ai/selected-conversation";
import { cookies } from "next/headers";
import { loadConversationHistory } from "@/lib/ai/conversation-history";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { ChatForm } from "./chat-form";
import { AnalysisPanel } from "./analysis-panel";
import { AiMessage } from "@/components/ai-message";

export default async function AiPage({ searchParams }: { searchParams: Promise<{ conversation?: string; threadsBefore?: string; messagesBefore?: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch (cause) {
    if (cause instanceof Error && cause.message === "Unauthorized") redirect("/login");
    return <main className="p-8"><p role="alert">Could not load workspace. Try again.</p></main>;
  }
  const { supabase, workspace, settings } = context;
  const params = await searchParams;
  const selectionKey = `moneo-conversation-${workspace.id}`;
  const requested = params.conversation ?? (await cookies()).get(selectionKey)?.value;
  let history: Awaited<ReturnType<typeof loadConversationHistory>>;
  try { history = await loadConversationHistory(supabase, workspace.id, requested, params.threadsBefore, params.messagesBefore); }
  catch (cause) { return <main className="mx-auto max-w-3xl p-8"><ConversationSelection selectionKey={selectionKey} id={requested ?? "new"} /><h1>Conversation unavailable</h1><p role="alert">{cause instanceof Error ? cause.message : "Could not load conversation"}</p><Link href="/ai?conversation=new">New conversation</Link><Link className="ml-4" href="/ai">Try again</Link></main>; }
  const { threads, selected, messages, threadsCursor, messagesCursor } = history;
  const href = (extra: Record<string, string>) => `/ai?${new URLSearchParams({ conversation: selected?.id ?? "new", ...extra })}`;

  return <main className="ai-evidence mx-auto grid max-w-7xl grid-cols-1 gap-5 px-4 py-6 lg:grid-cols-[13rem_minmax(0,1fr)] lg:px-8">
    <ConversationSelection selectionKey={selectionKey} id={selected?.id ?? "new"} />
    <aside className="min-w-0 rounded-xl border border-border bg-[#132030] p-4"><p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">AI / Evidence room</p>
      <Link href="/ai?conversation=new" className="mt-5 block rounded-lg bg-brand px-3 py-2.5 text-center text-sm font-semibold text-white hover:opacity-90">New conversation</Link>
      <nav aria-label="Conversations" className="mt-5 space-y-1">{threads?.map(thread => <Link key={thread.id} href={`/ai?conversation=${thread.id}`} aria-current={selected?.id === thread.id ? "page" : undefined} className={`block truncate rounded-lg px-3 py-2 text-sm ${selected?.id === thread.id ? "bg-muted font-medium text-brand" : "text-muted-foreground hover:bg-muted"}`}>{thread.title}</Link>)}</nav>{threadsCursor && <Link className="mt-3 block text-sm underline" href={href({ threadsBefore: threadsCursor })}>Older conversations</Link>}
      {params.threadsBefore && <Link className="mt-3 block text-sm underline" href={href({})}>Latest conversations</Link>}
      <Link href="/ai/library" className="mt-5 block text-sm underline">Saved tools and analyses</Link>
      <Link href="/ai/activity" className="mt-2 block text-sm underline">Activity</Link>
      <Link href="/notifications" className="mt-2 block text-sm underline">Notifications</Link>
    </aside>
    <section className="min-w-0 rounded-xl border border-border bg-card p-5 sm:p-8"><p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Personal finance / Analysis</p><h1 className="mt-2 text-2xl font-semibold tracking-tight">Every answer has a trail.</h1><p className="mt-2 text-sm text-muted-foreground">Personal finance analysis · your workspace, your evidence.</p>
      <div className="ai-scope mt-5" aria-label="AI data access"><span><strong>{workspace.display_currency}</strong> display currency</span><span>{workspace.timezone}</span><span>Permitted: {settings.ai_data_scopes.join(", ") || "no financial data"}</span></div>
      <h2 className="mt-6 text-sm font-medium text-muted-foreground">{selected?.title ?? "New conversation"}</h2>
      {!messages?.length && <div className="mt-7 rounded-lg border border-dashed border-border p-5"><h3 className="font-semibold">Start with a question.</h3><p className="mt-2 text-sm text-muted-foreground">Ask what changed in your spending, find a transaction, or create a spending chart. Financial facts come from your permitted data; missing facts stay unknown.</p></div>}
      {messagesCursor && <Link className="mt-4 block text-sm underline" href={href({ messagesBefore: messagesCursor, ...(params.threadsBefore ? { threadsBefore: params.threadsBefore } : {}) })}>Older messages</Link>}{params.messagesBefore && <Link className="mt-3 block text-sm underline" href={href({})}>Latest messages</Link>}
      <div className="mt-6 space-y-7" aria-live="polite">{messages?.map(item => <article key={item.id} className={item.role === "user" ? "ai-user-message" : "min-w-0"}><div className="mb-3 flex items-center gap-2 text-xs"><span className={`flex size-6 items-center justify-center rounded-md font-semibold ${item.role === "user" ? "bg-accent text-foreground" : "bg-primary text-primary-foreground"}`}>{item.role === "user" ? "Y" : "M"}</span><span className="font-semibold">{item.role === "user" ? "You" : "Moneo"}</span><time className="font-mono text-[10px] text-muted-foreground" dateTime={item.created_at}>{new Date(item.created_at).toLocaleString(workspace.locale, { timeZone: workspace.timezone })}</time></div>{item.role === "user" ? <p className="whitespace-pre-wrap break-words text-sm">{item.content}</p> : <AiMessage content={item.content} />}</article>)}</div>
      <ChatForm key={selected?.id ?? "new"} conversationId={selected?.id ?? crypto.randomUUID()} selectionKey={selectionKey} isNewConversation={!selected} />
      <AnalysisPanel locale={workspace.locale} timezone={workspace.timezone} />
    </section>
  </main>;
}

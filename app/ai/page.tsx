import Link from "next/link";
import { ConversationSelection } from "@/lib/ai/selected-conversation";
import { cookies } from "next/headers";
import { loadConversationHistory } from "@/lib/ai/conversation-history";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { ChatForm } from "./chat-form";
import { AnalysisPanel } from "./analysis-panel";
import { AiMessage } from "@/components/ai-message";
import { Menu, Plus, Sparkles } from "lucide-react";

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

  const conversations = <>
    <Link href="/ai?conversation=new" className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-muted"><Plus className="size-4" aria-hidden="true" />New chat</Link>
    <nav aria-label="Conversations" className="mt-4 space-y-0.5">{threads?.map(thread => <Link key={thread.id} href={`/ai?conversation=${thread.id}`} aria-current={selected?.id === thread.id ? "page" : undefined} className={`block truncate rounded-lg px-3 py-2 text-sm ${selected?.id === thread.id ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>{thread.title}</Link>)}</nav>
    {threadsCursor && <Link className="mt-2 block px-3 text-sm text-muted-foreground hover:text-foreground" href={href({ threadsBefore: threadsCursor })}>Older conversations</Link>}
    {params.threadsBefore && <Link className="mt-2 block px-3 text-sm text-muted-foreground hover:text-foreground" href={href({})}>Latest conversations</Link>}
    <div className="mt-6 space-y-0.5 border-t border-border pt-4 text-sm text-muted-foreground">
      <Link href="/ai/library" className="block rounded-lg px-3 py-2 hover:bg-muted hover:text-foreground">Saved tools and analyses</Link>
      <Link href="/ai/activity" className="block rounded-lg px-3 py-2 hover:bg-muted hover:text-foreground">Activity</Link>
      <Link href="/notifications" className="block rounded-lg px-3 py-2 hover:bg-muted hover:text-foreground">Notifications</Link>
    </div>
  </>;
  const scope = <p className="mt-2 text-center text-xs text-muted-foreground" aria-label="AI data access">Moneo can use: {settings.ai_data_scopes.map(scope => scope.replaceAll("_", " ")).join(", ") || "none"} · {workspace.display_currency} · {workspace.timezone}</p>;
  const summary = "flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground [&::-webkit-details-marker]:hidden";

  return <main className="flex min-h-[calc(100dvh-3.5rem)]">
    <ConversationSelection selectionKey={selectionKey} id={selected?.id ?? "new"} />
    <aside className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-64 shrink-0 overflow-y-auto border-r border-border bg-card/60 p-3 lg:block">{conversations}</aside>
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="relative flex items-center gap-2 px-4 py-2.5">
        <details className="lg:hidden"><summary className={summary} aria-label="Show conversations"><Menu className="size-4" aria-hidden="true" /></summary><div className="absolute inset-x-4 top-full z-20 max-h-[70dvh] overflow-y-auto rounded-2xl border border-border bg-card p-3 shadow-lg">{conversations}</div></details>
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{selected?.title ?? "New chat"}</h1>
        <details><summary className={summary}><Sparkles className="size-4" aria-hidden="true" />Run a deep review</summary><div className="absolute inset-x-4 top-full z-20 mx-auto max-h-[75dvh] max-w-3xl overflow-y-auto rounded-2xl border border-border bg-card shadow-lg"><AnalysisPanel locale={workspace.locale} timezone={workspace.timezone} /></div></details>
      </div>
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4">
        {messagesCursor && <Link className="mt-2 self-center text-sm text-muted-foreground hover:text-foreground" href={href({ messagesBefore: messagesCursor, ...(params.threadsBefore ? { threadsBefore: params.threadsBefore } : {}) })}>Older messages</Link>}{params.messagesBefore && <Link className="mt-2 self-center text-sm text-muted-foreground hover:text-foreground" href={href({})}>Latest messages</Link>}
        {!!messages?.length && <div className="space-y-8 py-6" aria-live="polite">{messages.map(item => <article key={item.id} className={item.role === "user" ? "flex justify-end" : "flex min-w-0 gap-3"}>
          <time className="sr-only" dateTime={item.created_at}>{new Date(item.created_at).toLocaleString(workspace.locale, { timeZone: workspace.timezone })}</time>
          {item.role === "user" ? <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-3xl bg-muted px-4 py-2.5 text-[15px]">{item.content}</p>
            : <><span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground" aria-hidden="true">M</span><div className="min-w-0 flex-1"><AiMessage content={item.content} /></div></>}
        </article>)}</div>}
        <ChatForm key={selected?.id ?? "new"} conversationId={selected?.id ?? crypto.randomUUID()} selectionKey={selectionKey} isNewConversation={!selected} empty={!messages?.length} scope={scope} />
      </div>
    </section>
  </main>;
}

import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { ChatForm } from "./chat-form";
import { AnalysisPanel } from "./analysis-panel";

function renderMessage(content: string) {
  const linkPattern = /(\/money\/transactions\?transaction=[0-9a-f-]{36}|\/ai\/library\/[0-9a-f-]{36})/gi;
  return content.split(linkPattern).map((part, index) => /^\/(money|ai)\//.test(part)
    ? <Link key={index} href={part} className="underline">{part.startsWith("/ai/") ? "Open saved tool" : "Open transaction and Undo"}</Link>
    : part);
}

export default async function AiPage({ searchParams }: { searchParams: Promise<{ conversation?: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/login"); }
  const { supabase, workspace } = context;
  const { conversation: requested } = await searchParams;
  const { data: threads } = await supabase.from("conversations").select("id, title")
    .eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(30);
  const selected = threads?.find(thread => thread.id === requested) ?? (!requested ? threads?.[0] : undefined);
  const { data: messages } = selected ? await supabase.from("messages").select("id, role, content, created_at")
    .eq("workspace_id", workspace.id).eq("conversation_id", selected.id)
    .order("created_at").limit(100) : { data: [] };

  return <main className="mx-auto grid max-w-6xl grid-cols-1 gap-5 px-5 py-8 lg:grid-cols-[15rem_minmax(0,1fr)] lg:px-8">
    <aside className="h-fit min-w-0 rounded-xl border border-border bg-card p-4 shadow-sm"><h1 className="text-3xl font-semibold tracking-tight text-foreground">AI</h1>
      <Link href="/ai?conversation=new" className="mt-5 block rounded-lg bg-brand px-3 py-2.5 text-center text-sm font-semibold text-white hover:opacity-90">New conversation</Link>
      <nav aria-label="Conversations" className="mt-5 space-y-1">{threads?.map(thread => <Link key={thread.id} href={`/ai?conversation=${thread.id}`} aria-current={selected?.id === thread.id ? "page" : undefined} className={`block truncate rounded-lg px-3 py-2 text-sm ${selected?.id === thread.id ? "bg-muted font-medium text-brand" : "text-muted-foreground hover:bg-muted"}`}>{thread.title}</Link>)}</nav>
      <Link href="/ai/library" className="mt-5 block text-sm underline">Saved tools and analyses</Link>
      <Link href="/ai/activity" className="mt-2 block text-sm underline">Activity</Link>
      <Link href="/notifications" className="mt-2 block text-sm underline">Notifications</Link>
    </aside>
    <section className="min-w-0 rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6"><h2 className="border-b border-border pb-4 text-xl font-semibold tracking-tight text-foreground">{selected?.title ?? "New conversation"}</h2>
      <div className="mt-5 space-y-3" aria-live="polite">{messages?.map(item => <article key={item.id} className={`rounded-xl p-4 ${item.role === "user" ? "bg-muted" : "border border-border bg-background"}`}><p className="text-xs font-semibold uppercase text-muted-foreground">{item.role}</p><p className="mt-2 whitespace-pre-wrap text-sm leading-6">{renderMessage(item.content)}</p></article>)}</div>
      <ChatForm conversationId={selected?.id ?? crypto.randomUUID()} />
      <AnalysisPanel locale={workspace.locale} timezone={workspace.timezone} />
    </section>
  </main>;
}

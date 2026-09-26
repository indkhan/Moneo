import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { ChatForm } from "./chat-form";
import { AnalysisPanel } from "./analysis-panel";

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

  return <main className="mx-auto grid max-w-6xl gap-8 px-6 py-10 md:grid-cols-[14rem_1fr]">
    <aside><Link href="/" className="text-sm text-muted-foreground">← Home</Link><h1 className="mt-2 text-3xl font-semibold">AI</h1>
      <Link href="/ai?conversation=new" className="mt-5 inline-block rounded border px-3 py-2 text-sm">New conversation</Link>
      <nav aria-label="Conversations" className="mt-5 space-y-2">{threads?.map(thread => <Link key={thread.id} href={`/ai?conversation=${thread.id}`} className="block truncate rounded border p-2 text-sm">{thread.title}</Link>)}</nav>
      <Link href="/ai/library" className="mt-5 block text-sm underline">Saved tools and analyses</Link>
    </aside>
    <section><h2 className="text-xl font-semibold">{selected?.title ?? "New conversation"}</h2>
      <div className="mt-5 space-y-4" aria-live="polite">{messages?.map(item => <article key={item.id} className="rounded border p-4"><p className="text-xs font-semibold uppercase text-muted-foreground">{item.role}</p><p className="mt-2 whitespace-pre-wrap text-sm">{item.content}</p></article>)}</div>
      <ChatForm conversationId={selected?.id ?? crypto.randomUUID()} />
      <AnalysisPanel />
    </section>
  </main>;
}

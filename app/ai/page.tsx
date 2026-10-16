import Link from "next/link";
import { ConversationSelection } from "@/lib/ai/selected-conversation";
import { cookies } from "next/headers";
import { loadConversationHistory } from "@/lib/ai/conversation-history";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { ChatWorkspace } from "@/components/chat-workspace";

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
  const scope = <p className="mt-2 text-center text-xs text-muted-foreground" aria-label="AI data access">Moneo can use: {settings.ai_data_scopes.map(scope => scope.replaceAll("_", " ")).join(", ") || "none"} · {workspace.display_currency} · {workspace.timezone}</p>;
  return <ChatWorkspace initial={history} newConversationId={crypto.randomUUID()} selectionKey={selectionKey} locale={workspace.locale} timezone={workspace.timezone} scope={scope} />;
}

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

const cursorSchema = z.object({ created_at: z.iso.datetime({ offset: true }), id: z.uuid() });
export type HistoryMessage = { id: string; role: string; content: string; created_at: string };
export type HistoryThread = { id: string; title: string; created_at: string };
const THREAD_PAGE = 30;
const MESSAGE_PAGE = 100;
export const conversationTitleSchema = z.string().trim().min(1).max(120);

function before(value?: string) {
  if (!value) return null;
  try { return cursorSchema.parse(JSON.parse(value)); } catch { throw new Error("Invalid history cursor"); }
}
function cursor(row: { id: string; created_at: string }) { return JSON.stringify({ id: row.id, created_at: row.created_at }); }
// ponytail: LIKE wildcards are escaped; PostgREST also treats * as %, so it becomes a one-character wildcard.
function likePattern(query: string) { return `%${query.replace(/[\\%_]/g, "\\$&").replaceAll("*", "_")}%`; }

/** Newest-first saved chats, keyset-paged; `query` searches titles and message text instead. */
export async function loadThreads(supabase: SupabaseClient, workspace: string, threadsBefore?: string, query?: string) {
  const live = () => supabase.from("conversations").select("id,title,created_at").eq("workspace_id", workspace).is("deleted_at", null);
  const q = query?.trim().slice(0, 100);
  if (q) {
    const pattern = likePattern(q);
    const [titles, hits] = await Promise.all([
      live().ilike("title", pattern).order("created_at", { ascending: false }).limit(THREAD_PAGE),
      supabase.from("messages").select("conversation_id").eq("workspace_id", workspace).ilike("content", pattern).order("created_at", { ascending: false }).limit(200),
    ]);
    if (titles.error || hits.error) throw new Error("Could not search conversations. Try again.");
    const known = new Set((titles.data ?? []).map(row => row.id));
    const extra = [...new Set((hits.data ?? []).map(row => row.conversation_id as string))].filter(id => !known.has(id)).slice(0, THREAD_PAGE);
    const matched = extra.length ? await live().in("id", extra) : { data: [], error: null };
    if (matched.error) throw new Error("Could not search conversations. Try again.");
    const threads = [...(titles.data ?? []), ...(matched.data ?? [])]
      .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, THREAD_PAGE) as HistoryThread[];
    return { threads, threadsCursor: null };
  }
  const tc = before(threadsBefore);
  let tq = live().order("created_at", { ascending: false }).order("id", { ascending: false });
  if (tc) tq = tq.or(`created_at.lt.${tc.created_at},and(created_at.eq.${tc.created_at},id.lt.${tc.id})`);
  const { data, error } = await tq.limit(THREAD_PAGE + 1);
  if (error) throw new Error("Could not load conversations. Try again.");
  const threads = (data ?? []).slice(0, THREAD_PAGE) as HistoryThread[];
  return { threads, threadsCursor: (data?.length ?? 0) > THREAD_PAGE ? cursor(threads[threads.length - 1]) : null };
}

/** One owned conversation and a newest page of its messages (oldest first), loaded in parallel. */
export async function loadConversation(supabase: SupabaseClient, workspace: string, id: string, messagesBefore?: string) {
  const mc = before(messagesBefore);
  if (!z.uuid().safeParse(id).success) throw new Error("Conversation unavailable");
  let mq = supabase.from("messages").select("id,role,content,created_at").eq("workspace_id", workspace).eq("conversation_id", id).order("created_at", { ascending: false }).order("id", { ascending: false });
  if (mc) mq = mq.or(`created_at.lt.${mc.created_at},and(created_at.eq.${mc.created_at},id.lt.${mc.id})`);
  const [conversation, page] = await Promise.all([
    supabase.from("conversations").select("id,title,created_at").eq("workspace_id", workspace).eq("id", id).is("deleted_at", null).maybeSingle(),
    mq.limit(MESSAGE_PAGE + 1),
  ]);
  if (conversation.error) throw new Error("Could not load conversation. Try again.");
  if (!conversation.data) throw new Error("Conversation unavailable. It may be missing or belong to another workspace.");
  if (page.error) throw new Error("Could not load messages. Try again.");
  const messages = (page.data ?? []).slice(0, MESSAGE_PAGE) as HistoryMessage[];
  const messagesCursor = (page.data?.length ?? 0) > MESSAGE_PAGE ? cursor(messages[messages.length - 1]) : null;
  return { selected: conversation.data as HistoryThread, messages: messages.reverse(), messagesCursor };
}

export async function loadConversationHistory(supabase: SupabaseClient, workspace: string, requested?: string, threadsBefore?: string, messagesBefore?: string) {
  before(messagesBefore);
  if (requested && requested !== "new" && !z.uuid().safeParse(requested).success) throw new Error("Conversation unavailable");
  const explicit = requested && requested !== "new" ? loadConversation(supabase, workspace, requested, messagesBefore) : null;
  explicit?.catch(() => {});
  const { threads, threadsCursor } = await loadThreads(supabase, workspace, threadsBefore);
  const fallback = !requested && threads[0] ? loadConversation(supabase, workspace, threads[0].id, messagesBefore) : null;
  const conversation = await (explicit ?? fallback);
  return { threads, threadsCursor, selected: conversation?.selected ?? null, messages: conversation?.messages ?? [], messagesCursor: conversation?.messagesCursor ?? null };
}

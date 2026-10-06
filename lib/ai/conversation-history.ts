import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

const cursorSchema = z.object({ created_at: z.iso.datetime({ offset: true }), id: z.uuid() });
export type HistoryMessage = { id: string; role: string; content: string; created_at: string };
export type HistoryThread = { id: string; title: string; created_at: string };
function before(value?: string) {
  if (!value) return null;
  try { return cursorSchema.parse(JSON.parse(value)); } catch { throw new Error("Invalid history cursor"); }
}
function cursor(row: { id: string; created_at: string }) { return JSON.stringify(row && { id: row.id, created_at: row.created_at }); }
export async function loadConversationHistory(supabase: SupabaseClient, workspace: string, requested?: string, threadsBefore?: string, messagesBefore?: string) {
  const tc = before(threadsBefore), mc = before(messagesBefore);
  if (requested && requested !== "new" && !z.uuid().safeParse(requested).success) throw new Error("Conversation unavailable");
  let tq = supabase.from("conversations").select("id,title,created_at").eq("workspace_id", workspace).order("created_at", { ascending: false }).order("id", { ascending: false });
  if (tc) tq = tq.or(`created_at.lt.${tc.created_at},and(created_at.eq.${tc.created_at},id.lt.${tc.id})`);
  const { data: threadRows, error: threadsError } = await tq.limit(31);
  if (threadsError) throw new Error("Could not load conversations. Try again.");
  const threads = (threadRows ?? []).slice(0, 30) as HistoryThread[];
  let selected: HistoryThread | null = requested ? null : threads[0] ?? null;
  if (requested && requested !== "new") {
    const result = await supabase.from("conversations").select("id,title,created_at").eq("workspace_id", workspace).eq("id", requested).maybeSingle();
    if (result.error) throw new Error("Could not load conversation. Try again.");
    if (!result.data) throw new Error("Conversation unavailable. It may be missing or belong to another workspace.");
    selected = result.data;
  }
  let messages: HistoryMessage[] = [], messagesCursor: string | null = null;
  if (selected) {
    let mq = supabase.from("messages").select("id,role,content,created_at").eq("workspace_id", workspace).eq("conversation_id", selected.id).order("created_at", { ascending: false }).order("id", { ascending: false });
    if (mc) mq = mq.or(`created_at.lt.${mc.created_at},and(created_at.eq.${mc.created_at},id.lt.${mc.id})`);
    const { data, error } = await mq.limit(101);
    if (error) throw new Error("Could not load messages. Try again.");
    messages = (data ?? []).slice(0, 100);
    messagesCursor = (data?.length ?? 0) > 100 ? cursor(messages[messages.length - 1]) : null;
    messages.reverse();
  }
  return { threads, selected, messages, messagesCursor, threadsCursor: (threadRows?.length ?? 0) > 30 ? cursor(threads[threads.length - 1]) : null };
}

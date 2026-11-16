import type { ChatAttachment } from "./chat-attachments";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { isSpoken } from "./voice-context";
import { callStubs, loadCalls, type CallCard } from "./voice-call-history";

const cursorSchema = z.object({ created_at: z.iso.datetime({ offset: true }), id: z.uuid() });
export type HistoryMessage = { id: string; role: string; content: string; created_at: string; plan?: string[]; tools?: SavedToolStep[]; model?: string; attachments?: ChatAttachment[]; spoken?: boolean; call?: CallCard };
export type SavedToolStep = { name: string; state: "done"; input?: unknown; output?: string };
export type HistoryThread = { id: string; title: string; created_at: string };
const THREAD_PAGE = 30;
const MESSAGE_PAGE = 30;
const OUTPUT_PREVIEW = 2000;
const preview = (output?: string) => output && output.length > OUTPUT_PREVIEW ? `${output.slice(0, OUTPUT_PREVIEW)}\n… (truncated)` : output;
const RUN_WINDOW_MS = 6 * 60_000;
export const conversationTitleSchema = z.string().trim().min(1).max(120);

function before(value?: string) {
  if (!value) return null;
  try { return cursorSchema.parse(JSON.parse(value)); } catch { throw new Error("Invalid history cursor"); }
}
function cursor(row: { id: string; created_at: string }) { return JSON.stringify({ id: row.id, created_at: row.created_at }); }
function likePattern(query: string) { return `%${query.replace(/[\\%_]/g, "\\$&").replaceAll("*", "_")}%`; }

export async function loadThreads(supabase: SupabaseClient, workspace: string, threadsBefore?: string, query?: string) {
  const live = () => supabase.from("conversations").select("id,title,created_at").eq("workspace_id", workspace).is("deleted_at", null).is("artifact_id", null);
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

export async function loadConversation(supabase: SupabaseClient, workspace: string, id: string, messagesBefore?: string) {
  const mc = before(messagesBefore);
  if (!z.uuid().safeParse(id).success) throw new Error("Conversation unavailable");
  let mq = supabase.from("messages").select("id,role,content,created_at,request_id,reply_to,attachments,context").eq("workspace_id", workspace).eq("conversation_id", id).order("created_at", { ascending: false }).order("id", { ascending: false });
  if (mc) mq = mq.or(`created_at.lt.${mc.created_at},and(created_at.eq.${mc.created_at},id.lt.${mc.id})`);
  const [conversation, page, run, stubs] = await Promise.all([
    supabase.from("conversations").select("id,title,created_at").eq("workspace_id", workspace).eq("id", id).is("deleted_at", null).maybeSingle(),
    mq.limit(MESSAGE_PAGE + 1),
    mc ? null : supabase.from("chat_requests").select("id,created_at").eq("workspace_id", workspace).eq("conversation_id", id).eq("status", "running")
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
    callStubs(supabase, workspace, id),
  ]);
  if (conversation.error) throw new Error("Could not load conversation. Try again.");
  if (!conversation.data) throw new Error("Conversation unavailable. It may be missing or belong to another workspace.");
  if (page.error) throw new Error("Could not load messages. Try again.");
  const rows = (page.data ?? []).slice(0, MESSAGE_PAGE) as (HistoryMessage & { request_id?: string | null; reply_to?: string | null; context?: unknown })[];
  const messagesCursor = (page.data?.length ?? 0) > MESSAGE_PAGE ? cursor(rows[rows.length - 1]) : null;
  const calls = await loadCalls(supabase, workspace, id, stubs, { requestIds: rows.flatMap(row => row.request_id ?? row.reply_to ?? []),
    from: messagesCursor ? rows[rows.length - 1].created_at : undefined, to: mc?.created_at });
  const visible = rows.filter(row => !calls.hidden.has((row.request_id ?? row.reply_to) as string));
  const activity = await savedActivity(supabase, workspace, visible.flatMap(row => row.role === "assistant" && row.reply_to ? [row.reply_to] : []));
  const messages: HistoryMessage[] = [...visible.map(({ reply_to, context, ...message }) => ({ ...message, request_id: undefined, ...(isSpoken(context) && { spoken: true }), ...(reply_to ? activity.get(reply_to) : undefined) })), ...calls.items]
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const latest = run?.data as { id: string; created_at: string } | null | undefined;
  const running = latest && Date.parse(latest.created_at) > Date.now() - RUN_WINDOW_MS ? latest.id : null;
  return { selected: conversation.data as HistoryThread, messages: messages.reverse(), messagesCursor, running };
}

const savedCall = z.object({ name: z.string(), input: z.unknown().optional(), output: z.string().optional() });
const planSteps = z.object({ steps: z.array(z.string()) });
const savedUsage = z.object({ model_id: z.string().min(1).max(200) });

async function savedActivity(supabase: SupabaseClient, workspace: string, requestIds: string[]) {
  const activity = new Map<string, { plan?: string[]; tools?: SavedToolStep[]; model?: string }>();
  if (!requestIds.length) return activity;
  const { data, error } = await supabase.from("chat_requests").select("id,tool_calls,usage").eq("workspace_id", workspace).in("id", requestIds);
  if (error) return activity;
  for (const row of (data ?? []) as { id: string; tool_calls: unknown; usage: unknown }[]) {
    const model = savedUsage.safeParse(row.usage).data?.model_id;
    const parsed = z.array(savedCall).safeParse(row.tool_calls);
    const calls = parsed.success ? parsed.data : [];
    const plan = calls.flatMap(call => call.name === "plan_investigation" ? [planSteps.safeParse(call.input)] : []).find(found => found.success)?.data?.steps;
    const tools = calls.filter(call => call.name !== "plan_investigation").map(call => ({ name: call.name, state: "done" as const, input: call.input, output: preview(call.output) }));
    activity.set(row.id, { ...(plan ? { plan } : {}), ...(tools.length ? { tools } : {}), ...(model ? { model } : {}) });
  }
  return activity;
}

export async function loadConversationHistory(supabase: SupabaseClient, workspace: string, requested?: string, threadsBefore?: string, messagesBefore?: string) {
  before(messagesBefore);
  if (requested && requested !== "new" && !z.uuid().safeParse(requested).success) throw new Error("Conversation unavailable");
  const explicit = requested && requested !== "new" ? loadConversation(supabase, workspace, requested, messagesBefore) : null;
  explicit?.catch(() => {});
  const { threads, threadsCursor } = await loadThreads(supabase, workspace, threadsBefore);
  const conversation = await explicit;
  return { threads, threadsCursor, selected: conversation?.selected ?? null, messages: conversation?.messages ?? [], messagesCursor: conversation?.messagesCursor ?? null, running: conversation?.running ?? null };
}

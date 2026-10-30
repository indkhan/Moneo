import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { STANDALONE_KINDS } from "./open-proposals";
import { callTaskSchema, callTurnSchema, type CallTurn } from "./voice-call-record";

export type CallExchange = { id: string; role: string; content: string; created_at: string };
/** A finished call as the chat shows it: the summary, its cards, the transcript and the chat messages it produced. */
export type CallCard = {
  id: string; durationSeconds: number; summary: string | null; summaryStatus: "pending" | "done" | "failed";
  transcript: CallTurn[];
  /** Requests still running when the call ended, with where they stand now. */
  unfinished: { text: string; status: "running" | "completed" | "failed" | "canceled" }[];
  /** Card ids made during the call, oldest first; each card loads its own current state. */
  cards: string[];
  exchanges: CallExchange[];
};
type CallRow = { id: string; duration_seconds: number; transcript: unknown; tasks: unknown; request_ids: string[]; summary: string | null; summary_status: CallCard["summaryStatus"]; created_at: string };

type CallStub = Pick<CallRow, "id" | "request_ids" | "created_at">;
// A conversation rarely has more than a handful of calls; the list holds ids only, never transcripts.
const STUB_LIMIT = 200;

/** Which calls a conversation has and the requests each started. Start it beside the page of messages so it adds no round trip. */
export const callStubs = (supabase: SupabaseClient, workspace: string, conversation: string) =>
  Promise.resolve(supabase.from("voice_calls").select("id,request_ids,created_at").eq("workspace_id", workspace).eq("conversation_id", conversation)
    .order("created_at", { ascending: false }).limit(STUB_LIMIT));

/** Calls to show on a page of messages (saved within its time range) and the request ids whose messages they replace. */
export async function loadCalls(supabase: SupabaseClient, workspace: string, conversation: string, stubs: Awaited<ReturnType<typeof callStubs>>, page: { requestIds: string[]; from?: string; to?: string }) {
  if (stubs.error) throw new Error("Could not load calls. Try again.");
  const all = (stubs.data ?? []) as CallStub[];
  const inPage = (stub: CallStub) => (!page.from || Date.parse(stub.created_at) >= Date.parse(page.from)) && (!page.to || Date.parse(stub.created_at) < Date.parse(page.to));
  const shown = all.filter(inPage).slice(0, 20);
  // A call whose card is on a newer page can still own messages on this one.
  const own = new Set(page.requestIds);
  const hidden = new Set([...shown, ...all.filter(stub => stub.request_ids.some(id => own.has(id)))].flatMap(stub => stub.request_ids));
  if (!shown.length) return { hidden, items: [] };
  const called = await supabase.from("voice_calls").select("id,duration_seconds,transcript,tasks,request_ids,summary,summary_status,created_at")
    .eq("workspace_id", workspace).eq("conversation_id", conversation).in("id", shown.map(stub => stub.id)).order("created_at", { ascending: false });
  if (called.error) throw new Error("Could not load calls. Try again.");
  const rows = (called.data ?? []) as CallRow[];

  const requestIds = [...new Set(rows.flatMap(row => row.request_ids))];
  const running = [...new Set(rows.flatMap(row => parseTasks(row.tasks).filter(task => task.status === "running").map(task => task.requestId)))];
  const [messages, cards, requests] = await Promise.all([
    requestIds.length ? supabase.from("messages").select("id,role,content,created_at,request_id,reply_to").eq("workspace_id", workspace).eq("conversation_id", conversation)
      .or(`request_id.in.(${requestIds.join(",")}),reply_to.in.(${requestIds.join(",")})`).order("created_at") : null,
    requestIds.length ? supabase.from("agent_proposals").select("id,chat_request_id").eq("workspace_id", workspace).in("chat_request_id", requestIds).in("kind", STANDALONE_KINDS).order("created_at") : null,
    running.length ? supabase.from("chat_requests").select("id,status").eq("workspace_id", workspace).in("id", running) : null,
  ]);
  if (messages?.error || cards?.error || requests?.error) throw new Error("Could not load calls. Try again.");
  const status = new Map((requests?.data ?? []).map(row => [row.id as string, row.status as CallCard["unfinished"][number]["status"]]));

  const items = rows.map(row => {
    const own = new Set(row.request_ids);
    const tasks = parseTasks(row.tasks);
    const transcript = z.array(callTurnSchema).safeParse(row.transcript);
    return {
      id: row.id, role: "assistant", content: "", created_at: row.created_at,
      call: {
        id: row.id, durationSeconds: row.duration_seconds, summary: row.summary, summaryStatus: row.summary_status,
        transcript: transcript.success ? transcript.data : [],
        unfinished: tasks.filter(task => task.status === "running").map(task => ({ text: task.text, status: status.get(task.requestId) ?? "running" })),
        cards: (cards?.data ?? []).filter(card => own.has(card.chat_request_id as string)).map(card => card.id as string),
        exchanges: (messages?.data ?? []).filter(message => own.has((message.request_id ?? message.reply_to) as string))
          .map(({ id, role, content, created_at }) => ({ id, role, content, created_at } as CallExchange)),
      } satisfies CallCard,
    };
  });
  return { hidden, items };
}

const parseTasks = (tasks: unknown) => z.array(callTaskSchema).catch([]).parse(tasks);

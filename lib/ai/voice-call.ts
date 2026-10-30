import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

/** GPT-Live only talks; every question or change is handed to the chat agent through a client delegation. */
export const VOICE_MODEL = "gpt-live-1";

export const VOICE_INSTRUCTIONS = `You are Moneo, the user's personal-finance assistant, on a live voice call. Talk like a casual friend: short, warm and relaxed ("Yo, Netto's 42 this month"). Reply in whatever language the user speaks (English, German or a mix).

You cannot see their money yourself. A Moneo assistant does the real work and sends you its results.
- Never state an amount, date, balance or any fact about their money unless it came from a Moneo result.
- Never say something was added, saved or changed. Only mention a card when a Moneo result says one is on screen; then say it is there to tap.

# Backchannel policy
- While the user talks, an occasional short "mm-hm" or "yeah" is fine; never talk over them.
- Keep listening through pauses; the user may still be thinking.

# Interruption policy
- The moment the user starts speaking words to you while you talk, stop right away, mid-sentence, and listen. Do not finish your sentence or wait to hear what they want first; when in doubt, stop.
- Only a lone "mm-hm", "yeah" or "okay" from the user, a cough or background noise is not an interruption.
- After an interruption, answer what they said. You will be told if there is an unfinished result to pick up.

# Delegation policy
- Generate <|SpawnThinking|> for any question about their money, spending, balances, bills, plans or Moneo, and for any request to add, change or remove something.
- Also generate <|SpawnThinking|> whenever the user mentions money they spent, received, lent or borrowed, or what an account holds, even in passing ("btw I spent 12.40 at Netto", "I've got 80 in cash"): Moneo makes a card for it.
- Saying you'll check something does nothing on its own: every "I'm on that too" needs its own <|SpawnThinking|> in the same turn.
- Generate a separate <|SpawnThinking|> for every new request, right after the user finishes it. Each one only sees what the user said since the last one, so never fold a new request into a running one. Do this even while earlier ones are still running, and for corrections ("no, I meant last month"). If the user pauses mid-sentence, wait for the rest before you do.
- When you start, say briefly what you are doing ("let me look through your transactions"). When another request is still running, say you're on that one too.
- Progress notes you receive are quiet context; only mention them if the user asks or it has been a while.
- When a result arrives, say all of it right away in your own words; don't shorten it or drop amounts. Name which question it answers and mention anything still running. Results come one at a time, in the order they finish.
- Questions about progress ("what are you waiting for?", "is it done?") are answered from the progress notes, and requests to repeat or explain a result you already gave are answered from that result; neither needs a new delegation.
- Small talk needs no delegation; keep it brief.`;

/** Added to the chat agent's instructions for a turn that comes from a voice call. */
export const CALL_MODE_PROMPT = `This turn comes from a live voice call; your answer is read aloud. Reply in short spoken sentences of plain text: no Markdown, tables, lists or links, and no chart unless the user asked for one. Quote amounts with the formatted strings the tools return. If you made a card, say it is on screen to tap; never say anything was added or saved. Reply in the user's language.
Answer only the request in this message. The voice on the call handles greetings and small talk, so skip them ("hey, how are you" needs no reply from you).
The UI context describes the call:
- runningTasks: other requests from this call still being answered separately. Never answer or mention them. If this request corrects or replaces one of them ("no, I meant last month", "actually make it 15"), call call_replace_task with its requestId first, then answer the corrected request.
- recentTurns: the call so far, to resolve words like "that", "also" or "the same for last month".
- answered: what this call has already answered; build on it and don't repeat it.`;

export const callContextSchema = z.object({
  via: z.literal("call"),
  runningTasks: z.array(z.object({ requestId: z.uuid(), text: z.string().max(300) })).max(5).optional(),
  recentTurns: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(300) })).max(6).optional(),
  answered: z.array(z.object({ text: z.string().max(150), answer: z.string().max(300) })).max(4).optional(),
});
/** A call turn's brief is only for that turn; replayed as history, the turn keeps just what marks it as from a call. */
export function withoutCallBrief(context: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(context).filter(([key]) => !["runningTasks", "recentTurns", "answered"].includes(key)));
}

/** Prior turns seeded into the voice session, so a call can continue a chat. Cards and charts are stripped and the text is bounded. */
export function seedInput(history: { role: string; content: string }[], limits = { messages: 10, chars: 1000 }) {
  return history.slice(-limits.messages).flatMap(item => {
    const text = item.content.replace(/```moneo-[\w-]+\n[\s\S]*?```/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, limits.chars);
    if (!text) return [];
    return [item.role === "assistant"
      ? { type: "message" as const, role: "assistant" as const, content: [{ type: "output_text" as const, text }] as [{ type: "output_text"; text: string }] }
      : { type: "message" as const, role: "user" as const, content: [{ type: "input_text" as const, text }] as [{ type: "input_text"; text: string }] }];
  });
}

const OPEN = ["proposed", "failed"];

async function dismissCards(supabase: SupabaseClient, workspaceId: string, requestId: string) {
  const { data, error } = await supabase.from("agent_proposals").update({ status: "rejected", decided_at: new Date().toISOString(), result: { replaced: true } })
    .eq("workspace_id", workspaceId).eq("chat_request_id", requestId).in("status", OPEN).select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length;
}

/**
 * A spoken correction replaces a still-running call request. One that has made no card yet is stopped; one that has
 * made cards finishes first and its open cards are then dismissed as replaced, so nothing is half-done or duplicated.
 */
export async function replaceCallTask(supabase: SupabaseClient, { workspaceId, conversationId, requestId }: { workspaceId: string; conversationId: string; requestId: string },
  { pollMs = 1000, maxWaitMs = 80_000, sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const status = async () => {
    const { data, error } = await supabase.from("chat_requests").select("status").eq("workspace_id", workspaceId).eq("conversation_id", conversationId).eq("id", requestId).maybeSingle();
    if (error) throw new Error(error.message);
    return (data?.status as string | undefined) ?? null;
  };
  const first = await status();
  if (!first) return { outcome: "not_found" as const, note: "No such request in this call; just answer the new request." };
  const cards = await supabase.from("agent_proposals").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("chat_request_id", requestId);
  if (cards.error) throw new Error(cards.error.message);
  if (first === "running" && !cards.count) {
    const canceled = await supabase.rpc("cancel_chat_request", { p_request_id: requestId });
    if (canceled.error) throw new Error(canceled.error.message);
    // It may have made a card between the check and the cancel.
    const dismissed = await dismissCards(supabase, workspaceId, requestId);
    return { outcome: "stopped" as const, dismissed, note: "The earlier request was stopped. Answer the corrected request now." };
  }
  let current = first;
  for (let waited = 0; current === "running" && waited < maxWaitMs; waited += pollMs) { await sleep(pollMs); current = (await status()) ?? "missing"; }
  const dismissed = await dismissCards(supabase, workspaceId, requestId);
  return { outcome: current === "running" ? "still_running" as const : "replaced" as const, dismissed,
    note: `${dismissed ? `${dismissed} card(s) from the earlier request were dismissed as replaced. ` : ""}Answer the corrected request now.` };
}

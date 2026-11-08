import { createClient } from "@supabase/supabase-js";
import { aiConfigured } from "@/lib/ai/configured";
import { conversationWords, saveTitle, writeTitle } from "@/lib/ai/chat-title";
import { modelForSettings } from "@/lib/ai/provider";
import { loadWorkspaceSettings } from "@/lib/settings";

export const maxDuration = 300;
const BATCH = 50;
/** Younger chats may still be titled by their own request or call. */
const SETTLE_AFTER_MS = 3_600_000;

/**
 * Names chats left with a stand-in title: older chats, a call whose summary failed, a chat that never said what it
 * was about. Each is asked once, so a chat is not paid for again; the run stops when the AI is down and resumes next hour.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return Response.json({ error: "Title service unavailable" }, { status: 503 });
  if (!(await aiConfigured())) return Response.json({ titled: 0 });
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await db.from("conversations").select("id, workspace_id").eq("title_settled", false).is("deleted_at", null).is("artifact_id", null)
    .lt("created_at", new Date(Date.now() - SETTLE_AFTER_MS).toISOString()).order("created_at", { ascending: false }).limit(BATCH);
  if (error) return Response.json({ error: "Chats unavailable" }, { status: 503 });
  let titled = 0;
  for (const row of data ?? []) {
    const words = await conversationWords(db, row.workspace_id, row.id);
    // Nothing was said, so there is nothing to name and nothing to ask again.
    if (!words) { await db.from("conversations").update({ title_settled: true }).eq("id", row.id); continue; }
    const written = await writeTitle(async () => modelForSettings(await loadWorkspaceSettings(db, row.workspace_id), "titles"), words);
    if (!written) break;
    await saveTitle(db, row.workspace_id, row.id, written.title);
    titled++;
  }
  return Response.json({ titled });
}

import { cronRoute } from "@/lib/cron";
import { serviceClient } from "@/lib/service-db";
import { aiConfigured } from "@/lib/ai/configured";
import { conversationWords, saveTitle, writeTitle } from "@/lib/ai/chat-title";
import { modelForSettings } from "@/lib/ai/provider";
import { loadWorkspaceSettings } from "@/lib/settings";

export const maxDuration = 300;
const BATCH = 50;
const SETTLE_AFTER_MS = 3_600_000;

export const GET = cronRoute(async () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return Response.json({ error: "Title service unavailable" }, { status: 503 });
  if (!(await aiConfigured())) return Response.json({ titled: 0 });
  const db = serviceClient(url, key);
  const { data, error } = await db.from("conversations").select("id, workspace_id").eq("title_settled", false).is("deleted_at", null).is("artifact_id", null)
    .lt("created_at", new Date(Date.now() - SETTLE_AFTER_MS).toISOString()).order("created_at", { ascending: false }).limit(BATCH);
  if (error) return Response.json({ error: "Chats unavailable" }, { status: 503 });
  let titled = 0;
  for (const row of data ?? []) {
    const words = await conversationWords(db, row.workspace_id, row.id);
    if (!words) { await db.from("conversations").update({ title_settled: true }).eq("id", row.id); continue; }
    const written = await writeTitle(async () => modelForSettings(await loadWorkspaceSettings(db, row.workspace_id), "titles"), words);
    if (!written) break;
    await saveTitle(db, row.workspace_id, row.id, written.title);
    titled++;
  }
  return Response.json({ titled });
});

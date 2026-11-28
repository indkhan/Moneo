import { requireWorkspace } from "@/lib/auth";
import { LOG_PAGE, listLogs, logFilterSchema } from "@/lib/logs/store";

export async function GET(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const filter = logFilterSchema.parse(Object.fromEntries(new URL(request.url).searchParams));
  const entries = await listLogs(context.supabase, context.workspace.id, filter, new Date());
  return Response.json({ entries, more: entries.length === LOG_PAGE }, { headers: { "Cache-Control": "no-store" } });
}

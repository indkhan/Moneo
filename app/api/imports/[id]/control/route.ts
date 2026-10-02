import { z } from "zod";
import { start } from "workflow/api";
import { createClient } from "@supabase/supabase-js";
import { requireWorkspace } from "@/lib/auth";
import { importFile } from "@/workflows/import-file";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const id = z.uuid().safeParse((await params).id);
  const input = z.object({ action: z.enum(["cancel", "resume"]), requestId: z.uuid() }).strict().safeParse(await request.json().catch(() => null));
  if (!id.success || !input.success) return Response.json({ error: "Invalid import control" }, { status: 400 });
  if (input.data.action === "resume" && !process.env.SUPABASE_SERVICE_ROLE_KEY) return Response.json({ error: "Import service is not configured" }, { status: 503 });
  const result = await context.supabase.rpc("control_import", { p_import_id: id.data, p_action: input.data.action, p_request_id: input.data.requestId });
  if (result.error) return Response.json({ error: result.error.message }, { status: result.error.code === "P0002" ? 404 : 400 });
  if (input.data.action === "resume" && result.data.started) {
    try { await start(importFile, [id.data, context.workspace.id, result.data.totalRows, result.data.runVersion]); }
    catch (error) {
      const service = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
      const failed = await service.rpc("finish_import_run", { p_import_id: id.data, p_workspace_id: context.workspace.id, p_run_version: result.data.runVersion, p_error: String(error) });
      if (failed.error) return Response.json({ error: "Could not persist import launch failure" }, { status: 500 });
      return Response.json({ error: "Could not resume import", status: failed.data }, { status: 503 });
    }
  }
  return Response.json(result.data);
}

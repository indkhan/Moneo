import { requireWorkspace } from "@/lib/auth";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { mapRows, parseCsv, parseExcel } from "@/lib/csv";
import { importRowPayload } from "@/lib/import-row";

const reviewSchema = z.object({ sourceId: z.string().min(1), action: z.enum(["accept", "reject"]),
  expectedRouteId: z.string().uuid().nullable().optional(), accountId: z.string().uuid().optional(),
  expectedAccountVersion: z.number().int().positive().optional() }).strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); }
  catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const { id } = await params;
  try {
    const { sourceId, action, expectedRouteId, accountId, expectedAccountVersion } = reviewSchema.parse(await request.json());
    const { supabase, workspace } = context;
    const { data: source, error: sourceError } = await supabase.from("source_transactions")
      .select("id, row_number, original_row, status, normalized_row").eq("id", sourceId).eq("import_id", id)
      .eq("workspace_id", workspace.id).maybeSingle();
    if (sourceError) throw sourceError;
    if (!source) return Response.json({ error: "Review row not found" }, { status: 404 });
    if (action === "accept" && source.status === "review" && !source.normalized_row) {
      const { data: imported, error: importError } = await supabase.from("imports")
        .select("mapping, route_accounts, storage_path, file_hash").eq("id", id).eq("workspace_id", workspace.id).single();
      if (importError) throw importError;
      if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Import service is not configured");
      if (!imported.storage_path.startsWith(`${workspace.id}/`)) throw new Error("Import file is outside the workspace");
      const service = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } });
      const file = await service.storage.from("imports").download(imported.storage_path);
      if (file.error) throw file.error;
      if (!file.data || file.data.size > 10_000_000) throw new Error("Stored import file unavailable");
      const bytes = await file.data.arrayBuffer();
      if (createHash("sha256").update(new Uint8Array(bytes)).digest("hex") !== imported.file_hash) throw new Error("Stored import file differs from the reviewed original");
      const rows = imported.storage_path.endsWith(".csv") ? parseCsv(new TextDecoder().decode(bytes)) : await parseExcel(bytes);
      const mapped = mapRows(rows, imported.mapping).find(row => row.rowNumber === source.row_number);
      if (!mapped) throw new Error("Excluded source observation cannot be accepted");
      const prepared = await service.rpc("prepare_import_review", { p_source_id: sourceId, p_workspace_id: workspace.id,
        p_mapping: imported.mapping, p_routes: imported.route_accounts, p_row: { ...importRowPayload(workspace.id, id, mapped), sourceId } });
      if (prepared.error) throw prepared.error;
    }
    const result = await supabase.rpc("resolve_normalized_import_review", {
      p_source_id: sourceId, p_action: action, p_expected_route_id: expectedRouteId ?? null,
      p_account_id: accountId ?? null, p_expected_account_version: expectedAccountVersion ?? null,
    });
    if (result.error) throw result.error;
    return Response.json({ status: result.data.status });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Review failed" }, { status: 400 });
  }
}

import { requireWorkspace } from "@/lib/auth";
import { mapRows, type SourceRow } from "@/lib/csv";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); }
  catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const { id } = await params;
  try {
    const { sourceId, action } = await request.json();
    if (typeof sourceId !== "string" || !["accept", "reject"].includes(action))
      return Response.json({ error: "Invalid review action" }, { status: 400 });
    const { supabase, workspace } = context;
    const { data: source, error: sourceError } = await supabase.from("source_transactions")
      .select("id, original_row, status").eq("id", sourceId).eq("import_id", id)
      .eq("workspace_id", workspace.id).maybeSingle();
    if (sourceError) throw sourceError;
    if (!source) return Response.json({ error: "Review row not found" }, { status: 404 });
    const { data: imported, error: importError } = await supabase.from("imports")
      .select("mapping").eq("id", id).eq("workspace_id", workspace.id).single();
    if (importError) throw importError;
    const mapped = action === "accept" ? mapRows([source.original_row as SourceRow], imported.mapping)[0] : null;
    const result = await supabase.rpc("resolve_import_review", {
      p_source_id: sourceId,
      p_action: action,
      p_posted_on: mapped?.postedOn ?? null,
      p_description: mapped?.description ?? null,
      p_amount_minor: mapped?.amountMinor.toString() ?? null,
      p_currency_code: mapped?.currencyCode ?? null,
    });
    if (result.error) throw result.error;
    return Response.json({ status: result.data.status });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Review failed" }, { status: 400 });
  }
}

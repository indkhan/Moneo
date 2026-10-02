import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";

const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("review"), transactionId: z.uuid(), version: z.number().int().nonnegative(),
    kind: z.enum(["ordinary", "refund", "transfer"]), feeIncluded: z.boolean().default(false) }).strict(),
  z.object({ action: z.literal("undo"), transactionId: z.uuid(), version: z.number().int().nonnegative(), eventId: z.uuid() }).strict(),
]);

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); }
  catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  try {
    const { id } = await params;
    const input = inputSchema.parse(await request.json());
    const { supabase, workspace } = context;
    const linked = await supabase.from("transaction_sources").select("source_transactions!inner(import_id, workspace_id)")
      .eq("transaction_id", input.transactionId).eq("source_transactions.import_id", id).eq("source_transactions.workspace_id", workspace.id).limit(1);
    if (linked.error) throw linked.error;
    if (!linked.data?.length) return Response.json({ error: "Import transaction not found" }, { status: 404 });
    if (input.action === "undo") {
      const event = await supabase.from("correction_events").select("id").eq("id", input.eventId)
        .eq("transaction_id", input.transactionId).eq("workspace_id", workspace.id).maybeSingle();
      if (event.error) throw event.error;
      if (!event.data) return Response.json({ error: "Review history not found" }, { status: 404 });
    }
    const result = input.action === "review"
      ? await supabase.rpc("resolve_transaction_classification", { p_transaction_id: input.transactionId, p_expected_version: input.version, p_kind: input.kind, p_fee_included: input.feeIncluded })
      : await supabase.rpc("undo_transaction_classification", { p_event_id: input.eventId, p_expected_version: input.version });
    if (result.error) throw result.error;
    return Response.json(result.data);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Classification review failed" }, { status: 400 });
  }
}

import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { pendingSettlementSchema } from "@/lib/finance/pending-holds";

const inputSchema = z.discriminatedUnion("action", [
  pendingSettlementSchema.extend({ action: z.literal("resolve"), postedId: z.uuid().nullable(), postedVersion: z.number().int().min(0).max(2147483647).nullable() }).strict(),
  z.object({ action: z.literal("undo"), resolutionId: z.uuid() }).strict(),
]);
export async function POST(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  try {
    const input = inputSchema.parse(await request.json());
    const result = input.action === "undo"
      ? await context.supabase.rpc("undo_pending_hold_resolution", { p_resolution_id: input.resolutionId })
      : await context.supabase.rpc("resolve_pending_hold", { p_pending_id: input.pendingId, p_expected_version: input.pendingVersion,
        p_expected_released_minor: input.expectedReleasedMinor, p_posted_id: input.postedId, p_posted_version: input.postedVersion,
        p_released_minor: input.releasedMinor, p_note: input.note, p_request_id: input.requestId });
    if (result.error) return Response.json({ error: result.error.message }, { status: result.error.code === "PT409" ? 409 : 400 });
    return Response.json(result.data);
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Pending resolution failed" }, { status: 400 }); }
}

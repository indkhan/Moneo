import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import { start } from "workflow/api";
import { financialReview } from "@/workflows/financial-review";

export async function startFinancialReview(db: SupabaseClient, workspaceId: string, requestId: string, chatRequestId?: string) {
  const claimed = await db.rpc("start_financial_review", { p_request_id: requestId, p_chat_request_id: chatRequestId ?? null });
  if (claimed.error) throw claimed.error;
  const { jobId, status, started } = claimed.data as { jobId: string; status: string; started: boolean };
  if (started) {
    try { await start(financialReview, [jobId, workspaceId]); }
    catch (error) {
      const service = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
      const failed = await service.from("background_jobs").update({ status: "failed", stage: "starting", error: String(error).slice(0, 2000) })
        .eq("id", jobId).eq("workspace_id", workspaceId).in("status", ["queued", "running"]);
      if (failed.error) throw failed.error;
      throw new Error("Could not start financial review");
    }
  }
  return { jobId, status };
}

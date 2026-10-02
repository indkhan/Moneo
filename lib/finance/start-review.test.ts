import { expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { start } from "workflow/api";
import { startFinancialReview } from "./start-review";
vi.mock("workflow/api", () => ({ start: vi.fn(async () => ({})) }));
vi.mock("@/workflows/financial-review", () => ({ financialReview: vi.fn() }));
it("starts only newly claimed review jobs and retries return the persisted job", async () => {
  vi.mocked(start).mockClear();
  const rpc = vi.fn().mockResolvedValueOnce({ data: { started: true, jobId: "job", status: "queued" }, error: null })
    .mockResolvedValueOnce({ data: { started: false, jobId: "job", status: "queued" }, error: null });
  const db = { rpc } as unknown as SupabaseClient;
  expect(await startFinancialReview(db, "workspace", "request", "chat")).toEqual({ jobId: "job", status: "queued" });
  expect(await startFinancialReview(db, "workspace", "request", "chat")).toEqual({ jobId: "job", status: "queued" });
  expect(start).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledWith("start_financial_review", { p_request_id: "request", p_chat_request_id: "chat" });
});

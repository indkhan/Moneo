import { beforeEach, expect, it, vi } from "vitest";
import { requireWorkspace } from "@/lib/auth";
import { saveSpendingPlan, toggleSpendingPlan } from "./actions";
vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const id = "00000000-0000-4000-8000-000000000001";
const request = "00000000-0000-4000-8000-000000000002";
const rpc = vi.fn(async () => ({ error: null }));
const builder = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(async () => ({ data: { id, currency_code: "EUR" }, error: null })), upsert: vi.fn(async () => ({ error: null })), update: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of [builder.select, builder.eq, builder.update]) fn.mockReturnValue(builder);
  vi.mocked(requireWorkspace).mockResolvedValue({ workspace: { id }, supabase: { from: () => builder, rpc } } as unknown as Awaited<ReturnType<typeof requireWorkspace>>);
});
function form(fields: Record<string, string>) {
  const result = new FormData();
  for (const [key, value] of Object.entries({ planId: id, version: "2", requestId: request, categoryId: id, currency: "EUR", ...fields })) result.set(key, value);
  return result;
}
it("uses versioned audited limit edits without re-enabling a disabled plan", async () => {
  await saveSpendingPlan(form({ amount: "400.01" }));
  expect(rpc).toHaveBeenCalledWith("edit_spending_plan", { p_id: id, p_expected_version: 2, p_request_id: request, p_patch: { limit_minor: "40001" } });
});
it("audits enable state and refuses missing concurrency metadata", async () => {
  await toggleSpendingPlan(form({ enabled: "false" }));
  expect(rpc).toHaveBeenCalledWith("edit_spending_plan", { p_id: id, p_expected_version: 2, p_request_id: request, p_patch: { enabled: false } });
  await expect(toggleSpendingPlan(form({ enabled: "true", version: "" }))).rejects.toThrow();
});

import { beforeEach, expect, it, vi } from "vitest";
import { requireWorkspace } from "@/lib/auth";
import { deleteAssumption, toggleAssumption, updateAssumption } from "./actions";

vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const id = "00000000-0000-4000-8000-000000000001";
const request = "00000000-0000-4000-8000-000000000002";
const rpc = vi.fn(async () => ({ error: null }));
const builder = { select: vi.fn(), eq: vi.fn(), single: vi.fn(async () => ({ data: { id, currency_code: "EUR" }, error: null })), update: vi.fn(), delete: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of [builder.select, builder.eq, builder.update, builder.delete]) fn.mockReturnValue(builder);
  vi.mocked(requireWorkspace).mockResolvedValue({ workspace: { id }, supabase: { from: () => builder, rpc } } as unknown as Awaited<ReturnType<typeof requireWorkspace>>);
});
function form(fields: Record<string, string>) {
  const result = new FormData();
  for (const [key, value] of Object.entries({ assumptionId: id, version: "3", requestId: request, ...fields })) result.set(key, value);
  return result;
}
it("passes exact edits and rendered version to the audited assumption RPC", async () => {
  await updateAssumption(form({ name: "Rent", amount: "-90071992547409.91", cadence: "monthly", startsOn: "2026-10-01", endsOn: "" }));
  expect(rpc).toHaveBeenCalledWith("edit_assumption", {
    p_id: id, p_expected_version: 3, p_request_id: request,
    p_patch: { name: "Rent", amount_minor: "-9007199254740991", kind: "expense", cadence: "monthly", starts_on: "2026-10-01", ends_on: null },
  });
});
it("audits disable and soft removal with optimistic concurrency", async () => {
  await toggleAssumption(form({ enabled: "false" }));
  expect(rpc).toHaveBeenCalledWith("edit_assumption", { p_id: id, p_expected_version: 3, p_request_id: request, p_patch: { enabled: false } });
  await deleteAssumption(form({}));
  expect(rpc).toHaveBeenCalledWith("edit_assumption", { p_id: id, p_expected_version: 3, p_request_id: request, p_patch: { removed: true } });
});
it("rejects stale form metadata and invalid ranges before writes", async () => {
  await expect(toggleAssumption(form({ enabled: "false", version: "" }))).rejects.toThrow();
  await expect(updateAssumption(form({ name: "Rent", amount: "-100", cadence: "monthly", startsOn: "2026-10-02", endsOn: "2026-10-01" }))).rejects.toThrow("End date");
  expect(rpc).not.toHaveBeenCalled();
});

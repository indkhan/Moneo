import { expect, it, vi } from "vitest";
const rpc = vi.hoisted(() => vi.fn(async () => ({ error: null })));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ supabase: { rpc } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { associateOccurrence, undoOccurrence } from "./actions";
const id = "00000000-0000-4000-8000-000000000001";
it("records explicit schedule, versions and partial intent", async () => {
  const form = new FormData(); form.set("assumption", `${id}:2`); form.set("transaction", `${id}:3`); form.set("scheduledOn", "2026-10-06"); form.set("fulfillment", "partial");
  await associateOccurrence(form);
  expect(rpc).toHaveBeenCalledWith("record_recurring_occurrence", { p_assumption_id: id, p_assumption_version: 2, p_scheduled_on: "2026-10-06", p_transaction_id: id, p_transaction_version: 3, p_completes_occurrence: false });
});
it("rejects malformed calendar dates before RPC", async () => {
  const form = new FormData(); form.set("assumption", `${id}:2`); form.set("transaction", `${id}:3`); form.set("scheduledOn", "2026-02-30"); form.set("fulfillment", "full");
  await expect(associateOccurrence(form)).rejects.toThrow();
});
it("guards undo with association version", async () => {
  const form = new FormData(); form.set("settlementId", id); form.set("version", "1");
  await undoOccurrence(form);
  expect(rpc).toHaveBeenCalledWith("undo_recurring_occurrence", { p_settlement_id: id, p_version: 1 });
});

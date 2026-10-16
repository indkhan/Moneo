import { beforeEach, expect, it, vi } from "vitest";
import { requireWorkspace } from "@/lib/auth";
import { quickEditTransaction } from "./actions";

vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirect"); }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const rpc = vi.fn();
function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries({ id: id(1), version: "3", requestId: id(2), category: "Food", originalCategory: "Food", note: "", originalNote: "", merchant: "", originalMerchant: "", query: "", ...values })) data.set(key, value);
  return data;
}
beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockImplementation(async (name: string) => ({ data: name === "correct_transaction" ? { version: 4 } : { batchId: id(9) }, error: null }));
  vi.mocked(requireWorkspace).mockResolvedValue({ supabase: { rpc } } as never);
});

it("audits category/note and merchant as separate undoable corrections on the latest version", async () => {
  await expect(quickEditTransaction(form({ category: "Dining", merchant: id(5) }))).rejects.toThrow("redirect");
  expect(rpc).toHaveBeenNthCalledWith(1, "correct_transaction", { p_transaction_id: id(1), p_expected_version: 3, p_category_name: "Dining", p_note: "" });
  expect(rpc).toHaveBeenNthCalledWith(2, "bulk_edit_transactions", { p_rows: [{ id: id(1), version: 4 }], p_patch: { merchant_id: id(5) }, p_request_id: id(2) });
});

it("writes nothing when nothing changed and rejects invented merchants", async () => {
  await expect(quickEditTransaction(form({}))).rejects.toThrow("redirect");
  expect(rpc).not.toHaveBeenCalled();
  await expect(quickEditTransaction(form({ merchant: "Invented" }))).rejects.toThrow();
  expect(rpc).not.toHaveBeenCalled();
});

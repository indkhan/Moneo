import { beforeEach, expect, it, vi } from "vitest";
import { saveWealthItem } from "./actions";

const rpc = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ supabase: { rpc } }) }));

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  const all = { id: "00000000-0000-4000-8000-000000000001", version: "0", requestId: "00000000-0000-4000-8000-000000000002", name: "Loan", currency: "EUR", asOf: "2026-11-01", standaloneConfirmed: "on", annualRate: "0", monthlyPayment: "0", ...fields };
  for (const [key, value] of Object.entries(all)) data.set(key, value);
  return data;
};
const stored = () => (rpc.mock.calls[0][1] as { p_record: { amount_minor: string } }).p_record.amount_minor;
beforeEach(() => { rpc.mockReset(); rpc.mockResolvedValue({ error: null }); });

it.each([["100.00"], ["-100.00"]])("stores a debt entered as %s as money owed", async amount => {
  await saveWealthItem(form({ kind: "debt", amount }));
  expect(stored()).toBe("-10000");
});

it("refuses a negative asset value", async () => {
  await expect(saveWealthItem(form({ kind: "asset", amount: "-1.00" }))).rejects.toThrow("cannot be negative");
  expect(rpc).not.toHaveBeenCalled();
});

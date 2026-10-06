import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { setManualBalance } from "./actions";

const mocks = vi.hoisted(() => ({ insert: vi.fn(), requireWorkspace: vi.fn(), currency: "EUR" }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: mocks.requireWorkspace }));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("redirect"); } }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-30T22:30:00Z"));
  mocks.insert.mockResolvedValue({ error: null });
  mocks.currency = "EUR";
  const accountQuery = { select: () => accountQuery, eq: () => accountQuery, maybeSingle: async () => ({ data: { currency_code: mocks.currency } }) };
mocks.requireWorkspace.mockResolvedValue({ workspace: { id: "workspace", timezone: "Europe/Berlin" }, supabase: { from: (name: string) => name === "accounts" ? accountQuery : { insert: mocks.insert } } });
});

it("keeps a historical manual balance on the selected local date west of UTC", async () => {
  const context = await mocks.requireWorkspace();
  context.workspace.timezone = "America/Los_Angeles";
  const form = new FormData();
  form.set("accountId", "00000000-0000-4000-8000-000000000001");
  form.set("asOf", "2026-09-29");
  form.set("amount", "1000.00");
  await expect(setManualBalance(form)).rejects.toThrow("redirect");
  expect(mocks.insert).toHaveBeenLastCalledWith(expect.objectContaining({ as_of: "2026-09-29T07:00:00.000Z" }));
});
afterEach(() => vi.useRealTimers());

it.each(["KWD", "BHD", "OMR"])("records exact decimal-dot manual balances for %s", async currency => {
  mocks.currency = currency;
  const form = new FormData();
  form.set("accountId", "00000000-0000-4000-8000-000000000001");
  form.set("asOf", "2026-10-01");
  form.set("amount", "-0.123");
  await expect(setManualBalance(form)).rejects.toThrow("redirect");
  expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ amount_minor: "-123", currency_code: currency }));
});

it("records today's verified manual balance at the actual time across Berlin midnight", async () => {
  const form = new FormData();
  form.set("accountId", "00000000-0000-4000-8000-000000000001");
  form.set("asOf", "2026-10-01");
  form.set("amount", "1000.00");
  await expect(setManualBalance(form)).rejects.toThrow("redirect");
  expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ amount_minor: "100000", as_of: "2026-09-30T22:30:00.000Z" }));
});

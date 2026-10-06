import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { setManualBalance } from "./actions";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), requireWorkspace: vi.fn(), currency: "EUR" }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: mocks.requireWorkspace }));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("redirect"); } }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-30T22:30:00Z"));
  mocks.rpc.mockResolvedValue({ error: null });
  mocks.currency = "EUR";
  const accountQuery = { select: () => accountQuery, eq: () => accountQuery, maybeSingle: async () => ({ data: { currency_code: mocks.currency } }) };
mocks.requireWorkspace.mockResolvedValue({ workspace: { id: "workspace", timezone: "Europe/Berlin" }, supabase: { rpc: mocks.rpc, from: (name: string) => name === "accounts" ? accountQuery : {} } });
});

it("keeps a historical manual balance on the selected local date west of UTC", async () => {
  const context = await mocks.requireWorkspace();
  context.workspace.timezone = "America/Los_Angeles";
  const form = new FormData();
  form.set("accountId", "00000000-0000-4000-8000-000000000001");
  form.set("requestId", "00000000-0000-4000-8000-000000000002");
  form.set("expectedSnapshotId", "");
  form.set("expectedVersion", "0");
  form.set("asOf", "2026-09-29");
  form.set("amount", "1000.00");
  await expect(setManualBalance(form)).rejects.toThrow("redirect");
  expect(mocks.rpc).toHaveBeenLastCalledWith("record_manual_balance", expect.objectContaining({ p_date: "2026-09-29", p_reviewed: false }));
});
afterEach(() => vi.useRealTimers());

it.each(["KWD", "BHD", "OMR"])("records exact decimal-dot manual balances for %s", async currency => {
  mocks.currency = currency;
  const form = new FormData();
  form.set("accountId", "00000000-0000-4000-8000-000000000001");
  form.set("requestId", "00000000-0000-4000-8000-000000000002");
  form.set("expectedSnapshotId", "");
  form.set("expectedVersion", "0");
  form.set("asOf", "2026-10-01");
  form.set("amount", "-0.123");
  await expect(setManualBalance(form)).rejects.toThrow("redirect");
  expect(mocks.rpc).toHaveBeenCalledWith("record_manual_balance", expect.objectContaining({ p_amount_minor: "-123" }));
});

it("forwards today's local date across Berlin midnight without inventing reviewed coverage", async () => {
  const form = new FormData();
  form.set("accountId", "00000000-0000-4000-8000-000000000001");
  form.set("requestId", "00000000-0000-4000-8000-000000000002");
  form.set("expectedSnapshotId", "");
  form.set("expectedVersion", "0");
  form.set("asOf", "2026-10-01");
  form.set("amount", "1000.00");
  await expect(setManualBalance(form)).rejects.toThrow("redirect");
  expect(mocks.rpc).toHaveBeenCalledWith("record_manual_balance", expect.objectContaining({ p_amount_minor: "100000", p_date: "2026-10-01", p_reviewed: false }));
});

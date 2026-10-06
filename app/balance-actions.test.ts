import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ rpc: vi.fn(), account: { currency_code: "EUR" } }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { id: "workspace", timezone: "Europe/Berlin" }, supabase: {
  rpc: fixture.rpc,
  from: () => { const query = { insert: async () => ({ error: null }), select: () => query, eq: () => query, maybeSingle: async () => ({ data: fixture.account, error: null }) }; return query; },
} }) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
import { setManualBalance } from "./actions";
const id = "00000000-0000-4000-8000-000000000001";
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-06T12:00:00Z")); fixture.rpc.mockReset().mockResolvedValue({ error: null }); });
afterEach(() => vi.useRealTimers());
function form(reviewed: boolean) { const form = new FormData(); Object.entries({ accountId: id, amount: "100.00", asOf: "2026-10-06", expectedSnapshotId: "", expectedVersion: "0", requestId: id, coveredTransactions: "[]" }).forEach(([key, value]) => form.set(key, value)); if (reviewed) form.set("reviewedActivity", "on"); return form; }
it("sends an explicit reviewed receipt and expected history through the domain command", async () => {
  await setManualBalance(form(true));
  expect(fixture.rpc).toHaveBeenCalledWith("record_manual_balance", { p_account_id: id, p_amount_minor: "10000", p_date: "2026-10-06", p_reviewed: true, p_covered_transactions: [], p_expected_snapshot_id: null, p_expected_version: 0, p_request_id: id });
});
it("never turns an unconfirmed date entry into reviewed coverage", async () => {
  await setManualBalance(form(false));
  expect(fixture.rpc.mock.calls[0][1]).toMatchObject({ p_reviewed: false, p_covered_transactions: null });
});

it("accepts canonical posted records before their first correction (version zero)", async () => {
  const f = form(true);
  f.set("coveredTransactions", JSON.stringify([{ id, version: 0, amount_minor: "-100", currency_code: "EUR", posted_on: "2026-10-06", posted_at: null }]));
  await setManualBalance(f);
  expect(fixture.rpc).toHaveBeenCalledTimes(1);
});

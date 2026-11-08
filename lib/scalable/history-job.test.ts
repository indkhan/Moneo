import { afterEach, expect, it, vi } from "vitest";
import { serviceDb } from "@/lib/bank/server";
import { loadWealthEvents } from "@/app/money/wealth/net-worth";
import { loadWealthItems } from "@/lib/finance/wealth";
import { rebuildScalableHistory } from "./history-job";
import { calculateHistory, readHistoryInput } from "./history";
import { withScalable } from "./server";

vi.mock("@/lib/bank/server", () => ({ serviceDb: vi.fn() }));
vi.mock("@/lib/finance/wealth", async original => ({ ...await original<typeof import("@/lib/finance/wealth")>(), loadWealthItems: vi.fn() }));
vi.mock("@/app/money/wealth/net-worth", async original => ({ ...await original<typeof import("@/app/money/wealth/net-worth")>(), loadWealthEvents: vi.fn() }));
vi.mock("./server", () => ({ withScalable: vi.fn(), scalableConfigured: () => true }));
vi.mock("./history", () => ({ readHistoryInput: vi.fn(), calculateHistory: vi.fn() }));
afterEach(() => vi.resetAllMocks());

const connection = { id: "c", workspace_id: "w", portfolio: { itemIds: ["cash"], knownItemIds: ["sold"] } };
const item = (id: string, as_of: string) => ({ id, as_of, name: id, kind: "asset", amount_minor: "1", currency_code: "EUR", linked_account_id: null, removed_at: null });
const setup = () => {
  const eq = vi.fn(async () => ({ error: null })), update = vi.fn(() => ({ eq })), rpc = vi.fn(async () => ({ data: 1, error: null }));
  vi.mocked(serviceDb).mockReturnValue({ rpc, from: () => ({ update }) } as never);
  vi.mocked(loadWealthEvents).mockResolvedValue([{ id: "e", item_id: "sold", before: null, created_at: "2026-11-03T10:00:00Z", undone_at: null, after: item("sold", "2026-11-03") }] as never);
  vi.mocked(loadWealthItems).mockResolvedValue([item("cash", "2026-11-05"), item("manual", "2020-01-01")] as never);
  vi.mocked(withScalable).mockImplementation(async (_id, _workspace, work) => work({} as never));
  vi.mocked(readHistoryInput).mockResolvedValue({ synthetic: true } as never);
  return { rpc, update };
};

it("saves a passing run and stops before the first synced value, ignoring valuations that are not Scalable's", async () => {
  const { rpc, update } = setup();
  vi.mocked(calculateHistory).mockReturnValue({ ok: true, days: [{ date: "2026-11-01", securitiesMinor: 1n, cryptoMinor: 2n, cashMinor: 3n, totalMinor: 6n }] });
  await expect(rebuildScalableHistory(connection, "Europe/Berlin", "2026-11-08")).resolves.toBe("saved");
  expect(vi.mocked(readHistoryInput).mock.calls[0].slice(1)).toEqual(["Europe/Berlin", "2026-11-03"]);
  expect(rpc).toHaveBeenCalledWith("replace_scalable_value_history", { p_connection_id: "c", p_checked_on: "2026-11-08",
    p_rows: [{ on_date: "2026-11-01", currency_code: "EUR", securities_minor: "1", crypto_minor: "2", cash_minor: "3", total_minor: "6" }] });
  expect(update).not.toHaveBeenCalled();
  // The run makes many calls, so the login must last through all of them.
  expect(vi.mocked(withScalable).mock.calls[0][4]).toBeGreaterThanOrEqual(600_000);
});

it("saves nothing and records the reason when the check fails", async () => {
  const { rpc, update } = setup();
  vi.mocked(calculateHistory).mockReturnValue({ ok: false, reason: "Shares of X do not match" });
  await expect(rebuildScalableHistory(connection, "UTC", "2026-11-08")).resolves.toBe("failed");
  expect(rpc).not.toHaveBeenCalled();
  expect(update).toHaveBeenCalledWith({ history_status: "failed", history_checked_on: "2026-11-08", history_error: "Shares of X do not match" });
});

it("records a Scalable failure instead of throwing, so the next connection still runs", async () => {
  const { rpc, update } = setup();
  vi.mocked(withScalable).mockRejectedValue(new Error("Scalable is down"));
  await expect(rebuildScalableHistory(connection, "UTC", "2026-11-08")).resolves.toBe("failed");
  expect(rpc).not.toHaveBeenCalled();
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ history_status: "failed", history_error: "Scalable is down" }));
});

it("waits for the first sync without using up today's try", async () => {
  const { update } = setup();
  vi.mocked(loadWealthEvents).mockResolvedValue([]);
  vi.mocked(loadWealthItems).mockResolvedValue([item("manual", "2020-01-01")] as never);
  await expect(rebuildScalableHistory({ ...connection, portfolio: null }, "UTC", "2026-11-08")).resolves.toBe("skipped");
  expect(withScalable).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});

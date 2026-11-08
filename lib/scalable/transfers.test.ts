import { describe, expect, it, vi } from "vitest";
import { readAllTransfers, transferRows } from "./transfers";

vi.mock("@/lib/bank/server", () => ({ serviceDb: vi.fn() }));
vi.mock("./server", () => ({ withScalable: vi.fn(), scalableConfigured: () => true }));

const cash = (id: string, transactionType: string, amount: string, lastEventAt = "2026-11-01T00:00:00.000Z", over = {}) => ({ id, status: "SETTLED", currency: "EUR", isCancellation: false, lastEventAt, description: "Note", cash: { transactionType, amount }, ...over });

describe("reading Scalable's transfers", () => {
  it("keeps deposits and withdrawals, dated in the owner's zone, and links a return to its withdrawal", () => {
    expect(transferRows({ transactions: [cash("A", "DEPOSIT", "600"), cash("RETURN-B", "DEPOSIT", "12.34"), cash("B", "WITHDRAWAL", "-12.34", "2026-10-31T12:30:00Z")] }, "Europe/Berlin")).toMatchObject([
      { provider_id: "A", type: "DEPOSIT", amount_minor: "60000", on_date: "2026-11-01", returns_provider_id: null },
      { provider_id: "RETURN-B", amount_minor: "1234", returns_provider_id: "B" },
      { provider_id: "B", type: "WITHDRAWAL", amount_minor: "-1234", on_date: "2026-10-31" },
    ]);
  });

  it("uses the workspace's calendar for the date", () => {
    expect(transferRows({ transactions: [cash("B", "WITHDRAWAL", "-1", "2026-10-31T23:30:00Z")] }, "Europe/Berlin")[0].on_date).toBe("2026-11-01");
    expect(transferRows({ transactions: [cash("B", "WITHDRAWAL", "-1", "2026-10-31T23:30:00Z")] }, "UTC")[0].on_date).toBe("2026-10-31");
  });

  it("leaves out everything that isn't a transfer", () => {
    expect(transferRows({ transactions: [cash("I", "INTEREST", "1"), cash("T", "TAX", "-1"), { id: "S", status: "SETTLED", lastEventAt: "2026-11-01T00:00:00Z", security: { isin: "X" }, cash: null }] }, "UTC")).toEqual([]);
  });

  it("reads every page once, with no other calls", async () => {
    const callTool = vi.fn(async (_name: string, args?: Record<string, unknown>) => args?.cursor ? { transactions: [cash("B", "DEPOSIT", "2"), cash("A", "DEPOSIT", "1")] } : { page: { nextCursor: "next" }, transactions: [cash("A", "DEPOSIT", "1")] });
    expect((await readAllTransfers({ callTool } as never, "UTC")).map(row => row.provider_id).sort()).toEqual(["A", "B"]);
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(callTool.mock.calls.every(call => call[0] === "list_portfolio_transactions")).toBe(true);
  });
});

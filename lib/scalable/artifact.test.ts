import { describe, expect, it, vi } from "vitest";

const live = vi.fn();
vi.mock("./server", () => ({ withScalable: () => live() }));
vi.mock("./live", async original => ({ ...await original(), activeScalableConnection: async () => ({ id: "c", tradingAccess: "full" }) }));
const { scalablePortfolio, scalableSecurity, scalableWatchlist } = await import("./artifact");

const portfolio = { currency: "EUR", asOf: "2026-11-06", valuedAt: "2026-11-06T16:00:00Z", totalMinor: "1250000", securitiesMinor: "1200000", cryptoMinor: "0", cashMinor: "50000",
  performance: [{ timeframe: "MAX", returnMinor: "150000" }, { timeframe: "INTRADAY", returnMinor: "-2000" }], itemIds: ["h1"],
  watchlist: [{ isin: "US0378331005", name: "Apple", priceMinor: "20000", currencyCode: "EUR", dayPercent: 1.2 }] };
const holding = { name: "MSCI World", currency_code: "EUR", amount_minor: "1200000", quantity_text: "100", unit_price_text: "120", cost_basis_minor: "1000000" };

/** A stand-in Supabase client: every query resolves to the given row. */
function db(connection: unknown, items: unknown[]) {
  const query = (result: unknown) => { const chain: Record<string, unknown> = {}; for (const name of ["select", "eq", "in", "not", "is", "order", "limit"]) chain[name] = () => chain;
    chain.maybeSingle = async () => ({ data: result, error: null }); chain.then = (resolve: (value: unknown) => void) => resolve({ data: items, error: null }); return chain; };
  return { from: (table: string) => query(table === "scalable_connections" ? connection : null) };
}
const context = (mode: "snapshot" | "live", connection: unknown = { last_synced_at: "2026-11-06T16:05:00Z", portfolio }) =>
  ({ supabase: db(connection, [holding]), workspace: { id: "ws" }, settings: { artifact_scalable_data: mode } }) as never;

describe("Scalable data for artifacts", () => {
  it("reads the last sync by default, without calling Scalable", async () => {
    live.mockClear();
    const result = await scalablePortfolio(context("snapshot"));
    expect(live).not.toHaveBeenCalled();
    expect(result).toMatchObject({ dataFrom: "last_sync", syncedAt: "2026-11-06T16:05:00Z", totalMinor: "1250000", cashMinor: "50000",
      returns: [{ period: "Today", returnMinor: "-2000" }, { period: "All time", returnMinor: "150000" }],
      positions: [{ name: "MSCI World", shares: "100", priceMinor: "12000", valueMinor: "1200000", costMinor: "1000000", gainMinor: "200000", gainPercent: 20 }] });
    expect(await scalableWatchlist(context("snapshot"))).toEqual({ dataFrom: "last_sync", syncedAt: "2026-11-06T16:05:00Z", items: portfolio.watchlist });
  });

  it("says so when Scalable has not synced yet", async () => {
    await expect(scalablePortfolio(context("snapshot", null))).rejects.toThrow("Scalable has not synced yet");
  });

  it("reads Scalable live only when Settings allows it", async () => {
    live.mockResolvedValueOnce({ items: [{ isin: "US0378331005", name: "Apple", type: null, quote: { priceMinor: "20100", currencyCode: "EUR" }, dayPercent: 1.5 }] });
    expect(await scalableWatchlist(context("live"))).toEqual({ dataFrom: "live", syncedAt: null, items: [{ isin: "US0378331005", name: "Apple", priceMinor: "20100", currencyCode: "EUR", dayPercent: 1.5 }] });
    await expect(scalableSecurity({ action: "quote", isin: "US0378331005" }, context("snapshot"))).rejects.toThrow("Live Scalable data is off in Settings");
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import CurrencyPage from "./page";

const fixture = vi.hoisted(() => ({ rates: [] as unknown[], older: [] as unknown[], olderError: null as unknown, olderQueries: [] as string[] }));

vi.mock("next/link", () => ({ default: "a" }));
vi.mock("@/components/currency-select", () => ({ CurrencySelect: () => null }));
vi.mock("@/components/safe-form", () => ({ SafeForm: () => null }));
vi.mock("./actions", () => ({ addFxRateSafely: vi.fn(), setDisplayCurrencySafely: vi.fn() }));
vi.mock("./rate-fields", () => ({ RateFields: () => null }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({
  workspace: { id: "synthetic", display_currency: "EUR", timezone: "Europe/Berlin", locale: "en" },
  supabase: { from: (table: string) => {
    let filter: string | null = null;
    const query = { select: () => query, eq: () => query, order: () => query, limit: () => query,
      or: (value: string) => { filter = value; fixture.olderQueries.push(value); return query; },
      then: (resolve: (result: unknown) => unknown) => resolve(table === "accounts"
        ? { data: [{ id: "a", name: "Swiss", currency_code: "CHF" }, { id: "b", name: "Main", currency_code: "EUR" }], error: null }
        : filter ? { data: fixture.older, error: fixture.olderError } : { data: fixture.rates, error: null }) };
    return query;
  } },
}) }));

const usdRates = (count: number) => Array.from({ length: count }, (_, index) => ({ from_currency: "USD", to_currency: "EUR", rate_text: "0.9", rate_date: `2026-01-${index}`, source: "manual" }));
const warning = "No CHF to EUR rate saved yet";
const page = async () => renderToStaticMarkup(await CurrencyPage({ searchParams: Promise.resolve({}) }));

beforeEach(() => { Object.assign(fixture, { rates: [], older: [], olderError: null, olderQueries: [] }); });

it("does not call a rate missing when it is only older than the capped list", async () => {
  fixture.rates = usdRates(100);
  fixture.older = [{ rate_date: "2020-01-01" }];
  expect(await page()).not.toContain(warning);
  expect(fixture.olderQueries).toEqual(["and(from_currency.eq.CHF,to_currency.eq.EUR),and(from_currency.eq.EUR,to_currency.eq.CHF)"]);
});

it("warns when a full list and the direct check both find no rate", async () => {
  fixture.rates = usdRates(100);
  expect(await page()).toContain(warning);
});

it("trusts a list below the cap without another query", async () => {
  fixture.rates = usdRates(3);
  expect(await page()).toContain(warning);
  expect(fixture.olderQueries).toEqual([]);
});

it("shows the error page instead of a false warning when the direct check fails", async () => {
  fixture.rates = usdRates(100);
  fixture.olderError = { message: "offline" };
  await expect(page()).rejects.toThrow("Currency data could not be loaded");
});

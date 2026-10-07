import { afterEach, describe, expect, it, vi } from "vitest";
import { requireWorkspace } from "@/lib/auth";
import { spendingForArtifact, tripForArtifact } from "./finance-sdk";
import { evaluatePlan } from "@/lib/finance/model";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { accountLiquidity } from "@/lib/finance/calculations";

vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("@/lib/finance/model", () => ({ evaluatePlan: vi.fn() }));

describe("artifact spending coverage", () => {
  afterEach(() => vi.useRealTimers());

  it("attaches source-only overlap evidence and retains an unknown scope for filtered artifacts", async () => {
    const from = (table: string) => {
      const query = { select: () => query, eq: () => query, neq: () => query, gte: () => query, lte: () => query, order: () => query, ilike: () => query,
        single: async () => ({ data: { permissions: ["spending"], active_version_id: "v" }, error: null }),
        range: async () => ({ data: table === "imports" ? [{ id: "i", status: "completed", total_rows: 1 }] : table === "source_transactions" ? [{ import_id: "i", status: "review", posted_on: "2026-10-01", currency_code: "EUR" }] : [], error: null }) };
      return query;
    };
    vi.mocked(requireWorkspace).mockResolvedValue({ settings: DEFAULT_SETTINGS, workspace: { id: "w", display_currency: "EUR", timezone: "Europe/Berlin" }, supabase: { from } } as unknown as Awaited<ReturnType<typeof requireWorkspace>>);
    expect(await spendingForArtifact("a", "Shop", "spending", "2026-10")).toMatchObject({ sourceCoverage: { unresolvedSourceRows: 1,
      scope: { descriptionFilter: "applied; source relevance unknown" }, totalsAreBounds: false } });
  });

  it("dates the default trip seven calendar days ahead in the workspace timezone", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-30T22:30:00Z"));
    const permission = { select: () => permission, eq: () => permission,
      single: async () => ({ data: { permissions: ["forecast"], active_version_id: "v" }, error: null }) };
    vi.mocked(requireWorkspace).mockResolvedValue({ workspace: { id: "w", display_currency: "EUR", timezone: "Europe/Berlin" },
      supabase: { from: () => permission } } as unknown as Awaited<ReturnType<typeof requireWorkspace>>);
    vi.mocked(evaluatePlan).mockResolvedValue({ input: { startDate: "2026-10-01", horizonDays: 30, currencyCode: "EUR", accounts: [], events: [] }, available: { status: "unavailable" } } as unknown as Awaited<ReturnType<typeof evaluatePlan>>);
    expect((await tripForArtifact("a", 100n)).tripDate).toBe("2026-10-08");
  });

  it("pages all matched posted rows including refunds in the Berlin month", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T22:30:00Z"));
    const ranges: number[][] = [];
    const filters: unknown[][] = [];
    const transactions = Array.from({ length: 1001 }, (_, index) => ({
      id: String(index), posted_on: "2026-10-01", description: "Shop", amount_minor: "-100",
      currency_code: "EUR", account_id: "checking", category_id: null, status: "posted", kind: "ordinary",
      review_reasons: [] as string[],
    }));
    transactions[1000] = { ...transactions[1000], account_id: "savings", amount_minor: "1000", kind: "refund" };
    transactions[999].review_reasons = ["source_transfer"];
    const unmatched = { ...transactions[0], description: "Other", currency_code: "USD" };
    let filtered = false;
    const tables: string[] = [];
    const builder: Record<string, unknown> = {};
    for (const method of ["select", "eq", "neq", "gte", "lte", "order", "ilike", "limit"]) {
      builder[method] = vi.fn((...args: unknown[]) => {
        filters.push([method, ...args]);
        if (method === "ilike") filtered = true;
        return builder;
      });
    }
    builder.range = vi.fn(async (from: number, to: number) => {
      ranges.push([from, to]);
      return { data: (filtered ? transactions : [...transactions, unmatched]).slice(from, to + 1), error: null };
    });
    builder.then = (resolve: (value: unknown) => unknown) => resolve({ data: transactions.slice(0, 50), error: null });
    const permission = { select: () => permission, eq: () => permission,
      single: async () => ({ data: { permissions: ["spending"], active_version_id: "v" }, error: null }) };
    vi.mocked(requireWorkspace).mockResolvedValue({
      workspace: { id: "w", display_currency: "EUR" },
      supabase: { from: (table: string) => { tables.push(table); filtered = false; return table === "artifacts" ? permission : builder; } },
    } as unknown as Awaited<ReturnType<typeof requireWorkspace>>);
    const result = await spendingForArtifact("a", "Shop");
    expect(result).toMatchObject({ from: "2026-10-01", to: "2026-10-01",
      summary: { incomeMinor: "0", spendingMinor: "98900", netMinor: "-98900", partial: true, excludedReviewRows: 1 } });
    expect(result.transactions).toHaveLength(1000);
    expect(result.byAccount).toEqual([
      { id: "checking", incomeMinor: "0", spendingMinor: "99900", netMinor: "-99900", partial: true, excludedReviewRows: 1 },
      { id: "savings", incomeMinor: "0", spendingMinor: "-1000", netMinor: "1000", partial: false, excludedReviewRows: 0 },
    ]);
    expect(ranges).toEqual([[0, 999], [1000, 1999]]);
    expect(filters).toContainEqual(["neq", "kind", "transfer"]);
    expect(filters).toContainEqual(["ilike", "description", "%Shop%"]);
    expect(tables).toContain("effective_transactions");
    expect(tables).not.toContain("transactions");
    const september = await spendingForArtifact("a", "Shop", "spending", "2026-09");
    expect(september).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    await expect(spendingForArtifact("a", "Shop", "spending", "2026-99")).rejects.toThrow();
  });
});

it("evaluates an explicit dated trip with a derived horizon and the shared engine", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  const permission = { select: () => permission, eq: () => permission, single: async () => ({ data: { permissions: ["forecast"], active_version_id: "v" }, error: null }) };
  vi.mocked(requireWorkspace).mockResolvedValue({ workspace: { id: "w", display_currency: "EUR", timezone: "Europe/Berlin" }, supabase: { from: () => permission } } as unknown as Awaited<ReturnType<typeof requireWorkspace>>);
  vi.mocked(evaluatePlan).mockImplementation(async days => ({ input: { startDate: "2026-10-01", horizonDays: days, currencyCode: "EUR",
    accounts: [{ id: "checking", currencyCode: "EUR", balanceMinor: 10000n }], events: [{ accountId: "checking", date: "2026-10-03", expectedMinor: 100000n }] } }) as Awaited<ReturnType<typeof evaluatePlan>>);
  const scenario = { version: 1, destination: "Synthetic", startsOn: "2026-11-01", endsOn: "2026-11-03", postTripDays: 7,
    payments: [{ name: "Flight", kind: "cost", date: "2026-11-01", accountId: "checking", currencyCode: "EUR", amountMinor: "20000" }] };
  const result = await tripForArtifact("a", 20000n, "checking", [], scenario);
  expect(evaluatePlan).toHaveBeenLastCalledWith(41, undefined, false);
  expect(result).toMatchObject({ horizon: { from: "2026-10-01", to: "2026-11-10", days: 41 }, withTripAvailableMinor: "10000", afterTripMinor: "90000", limitingDate: "2026-10-01" });
  const expected = accountLiquidity({ startDate: "2026-10-01", horizonDays: 41, currencyCode: "EUR", accounts: [{ id: "checking", currencyCode: "EUR", balanceMinor: 10000n }], events: [{ accountId: "checking", date: "2026-10-03", expectedMinor: 100000n }], scenarioEvents: [{ accountId: "checking", date: "2026-11-01", expectedMinor: -20000n }] });
  if (expected.status === "available") expect(result.withTripAvailableMinor).toBe(expected.accounts[0].spendableMinor.toString());
  vi.useRealTimers();
});

it("rechecks artifact permission and finance scopes before returning an asynchronous trip preview", async () => {
  const query = { select: () => query, eq: () => query, single: async () => ({ data: { permissions: ["forecast"], active_version_id: "v" }, error: null }) };
  const context = { workspace: { id: "w", display_currency: "EUR", timezone: "Europe/Berlin" }, settings: { ...DEFAULT_SETTINGS, ai_data_scopes: ["accounts", "transactions", "planning"] }, supabase: { from: () => query } };
  vi.mocked(requireWorkspace).mockResolvedValueOnce(context as unknown as Awaited<ReturnType<typeof requireWorkspace>>)
    .mockResolvedValueOnce({ ...context, settings: { ...context.settings, ai_data_scopes: [] } } as unknown as Awaited<ReturnType<typeof requireWorkspace>>);
  vi.mocked(evaluatePlan).mockResolvedValue({ input: { startDate: new Date().toISOString().slice(0, 10), horizonDays: 29, currencyCode: "EUR", accounts: [{ id: "a", currencyCode: "EUR", balanceMinor: 10000n }], events: [] } } as unknown as Awaited<ReturnType<typeof evaluatePlan>>);
  await expect(tripForArtifact("synthetic", 20000n)).rejects.toThrow("disabled");
});

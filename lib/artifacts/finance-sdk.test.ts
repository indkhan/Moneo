import { afterEach, describe, expect, it, vi } from "vitest";
import { requireWorkspace } from "@/lib/auth";
import { spendingForArtifact, tripForArtifact } from "./finance-sdk";
import { evaluatePlan } from "@/lib/finance/model";

vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("@/lib/finance/model", () => ({ evaluatePlan: vi.fn() }));

describe("artifact spending coverage", () => {
  afterEach(() => vi.useRealTimers());

  it("dates the default trip seven calendar days ahead in the workspace timezone", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-30T22:30:00Z"));
    const permission = { select: () => permission, eq: () => permission,
      single: async () => ({ data: { permissions: ["forecast"], active_version_id: "v" }, error: null }) };
    vi.mocked(requireWorkspace).mockResolvedValue({ workspace: { id: "w", display_currency: "EUR", timezone: "Europe/Berlin" },
      supabase: { from: () => permission } } as unknown as Awaited<ReturnType<typeof requireWorkspace>>);
    vi.mocked(evaluatePlan).mockResolvedValue({ input: { accounts: [] }, available: { status: "unavailable" } } as unknown as Awaited<ReturnType<typeof evaluatePlan>>);
    expect((await tripForArtifact("a", 100n)).tripDate).toBe("2026-10-08");
  });

  it("pages all matched posted rows including refunds in the Berlin month", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T22:30:00Z"));
    const ranges: number[][] = [];
    const filters: unknown[][] = [];
    const transactions = Array.from({ length: 1001 }, (_, index) => ({
      id: String(index), posted_on: "2026-10-01", description: "Shop", amount_minor: "-100",
      currency_code: "EUR", category_id: null, status: "posted", kind: "ordinary",
      review_reasons: [] as string[],
    }));
    transactions[1000] = { ...transactions[1000], amount_minor: "1000", kind: "refund" };
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

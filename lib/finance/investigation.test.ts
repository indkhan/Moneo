import { describe, expect, it } from "vitest";
import { investigate, investigationSchema, resolveInvestigation, type InvestigationRow } from "./investigation";

const account = "11111111-1111-4111-8111-111111111111";
const category = "22222222-2222-4222-8222-222222222222";
const merchant = "33333333-3333-4333-8333-333333333333";
const row = (id: string, amount = "-100", date = "2026-09-01"): InvestigationRow => ({
  id, parentId: id, accountId: account, categoryId: category, merchantId: merchant,
  date, amountMinor: amount, currency: "EUR", status: "posted", kind: "ordinary",
  tags: ["food"], event: null, reviewReasons: [], version: 1, description: "Shop",
});
const query = { version: 1, period: { from: "2026-09-01", to: "2026-09-30" },
  comparison: { from: "2026-08-01", to: "2026-08-31" },
  accounts: { include: [{ id: account }] }, categories: { include: [{ id: category }] },
  events: { exclude: ["Berlin trip"] }, groupBy: ["category", "merchant"], metric: "spending" };
const context = { workspaceId: "owned", capturedAt: "2026-10-01T00:00:00Z" };

describe("deterministic investigations", () => {
  it("compares chosen periods exactly and pages every supporting effective row", () => {
    const rows = Array.from({ length: 25 }, (_, i) => row(`r${i}`));
    rows.push(row("aug", "-1000", "2026-08-03"), { ...row("trip", "-999"), event: "Berlin trip" });
    const result = investigate(query, rows, context);
    expect(result.groups[0]).toMatchObject({ currentMinor: "2500", comparisonMinor: "1000", deltaMinor: "1500" });
    expect(result.records.total).toBe(26);
    expect(result.records.items).toHaveLength(25);
    const next = investigate({ ...query, page: { cursor: result.records.nextCursor } }, rows, context);
    expect(next.records.items).toHaveLength(1);
    expect(next.queryId).toBe(result.queryId);
    expect(new Set([...result.records.items, ...next.records.items].map(r => r.id)).size).toBe(26);
  });
  it("keeps currencies separate and preserves refunds, splits, fees and classification uncertainty", () => {
    const rows = [row("split1", "-60"), { ...row("split2", "-40"), parentId: "split1" },
      { ...row("refund", "30"), kind: "refund" as const }, { ...row("transfer", "-500"), kind: "transfer" as const },
      { ...row("fee", "-5"), parentId: "transfer" }, { ...row("unknown", "-999"), reviewReasons: ["source_transfer"] },
      { ...row("pending", "-100"), status: "pending" as const }, { ...row("usd", "-200"), currency: "USD" }];
    const result = investigate(query, rows, context);
    expect(result.groups.find(g => g.currency === "EUR")?.currentMinor).toBe("75");
    expect(result.groups.find(g => g.currency === "USD")?.currentMinor).toBe("200");
    expect(result.coverage).toMatchObject({ classificationExcluded: 1, pendingExcluded: 1, transferExcluded: 1, partial: true });
    expect(result.coverage.limitation).toContain("not upper or lower bounds");
    expect(result.records.items.find(r => r.id === "split2")?.link).toContain("transaction=split1");
  });
  it("validates dates, ownership resolution and ambiguity without fabricating identifiers", () => {
    expect(investigationSchema.safeParse({ ...query, period: { from: "2026-02-30", to: "2026-03-01" } }).success).toBe(false);
    expect(investigationSchema.safeParse({ ...query, period: { from: "2026-09-30", to: "2026-09-01" } }).success).toBe(false);
    const entities = { accounts: [{ id: account, name: "Checking" }], categories: [{ id: category, name: "Groceries" }], merchants: [] };
    expect(resolveInvestigation({ ...query, accounts: { include: [{ name: "Checking" }] } }, entities).accounts?.include).toEqual([{ id: account }]);
    expect(() => resolveInvestigation({ ...query, merchants: { include: [{ name: "Unknown" }] } }, entities)).toThrow("Unknown");
    expect(() => resolveInvestigation(query, { ...entities, accounts: [] })).toThrow("owned");
    expect(() => resolveInvestigation({ ...query, accounts: { include: [{ name: "Checking" }] } }, {
      ...entities, accounts: [...entities.accounts, { id: category, name: "Checking" }],
    })).toThrow("Ambiguous");
    expect(resolveInvestigation(query, { ...entities, labels: { tags: ["food"], events: ["Berlin Trip"] } }).events?.exclude).toEqual(["Berlin Trip"]);
    expect(() => resolveInvestigation(query, { ...entities, labels: { tags: [], events: [] } })).toThrow("Unknown owned events");
  });
  it("identifies changed date/source/classification evidence and rejects stale pagination", () => {
    const rows = Array.from({ length: 26 }, (_, i) => row(`r${i}`));
    const first = investigate(query, rows, context);
    const changed = rows.map((r, i) => i ? r : { ...r, date: "2026-09-02", version: 2 });
    expect(investigate(query, changed, context).evidenceId).not.toBe(first.evidenceId);
    expect(() => investigate({ ...query, page: { cursor: first.records.nextCursor } }, changed, context)).toThrow("changed");
  });
  it("allocates canonical FX rounding across split groups once and preserves full support on missing rates", () => {
    const rows = [{ ...row("a", "-1"), currency: "USD", parentId: "parent" },
      { ...row("b", "-1"), currency: "USD", parentId: "parent", categoryId: null }];
    const args = { ...query, categories: undefined, currencyPolicy: { mode: "base", currency: "EUR" }, groupBy: ["category"] };
    const rates = [{ id: "rate", fromCurrency: "USD", toCurrency: "EUR", rateText: "0.5", rateDate: "2026-09-01", source: "synthetic" }];
    const result = investigate(args, rows, { ...context, rates });
    expect(result.groups.map(g => g.currentMinor).sort()).toEqual(["0", "1"]);
    expect(result.reporting?.policy.aggregation).toBe("canonical-parent-financial-kind");
    expect(result.reporting?.allocationPolicy).toContain("largest-remainder");
    const missing = investigate(args, rows, context);
    expect(missing.groups.every(g => g.currentMinor === null)).toBe(true);
    expect(missing.records.total).toBe(2);
    expect(missing.coverage.missingConversionRows).toBe(2);
  });
  it("keeps selected transfer principals neutral for accounting metrics and explicit for gross-flow metrics", () => {
    const rows = [{ ...row("transfer", "-500"), kind: "transfer" as const }, row("fee", "-5")];
    const args = { ...query, kinds: ["ordinary", "transfer", "refund"] };
    expect(investigate(args, rows, context).groups[0].currentMinor).toBe("5");
    expect(investigate({ ...args, metric: "net" }, rows, context).groups[0].currentMinor).toBe("-5");
    expect(investigate({ ...args, metric: "signed" }, rows, context).groups[0].currentMinor).toBe("-505");
    expect(investigate({ ...args, metric: "absolute" }, rows, context).groups[0].currentMinor).toBe("505");
  });
  it("counts overlapping-period supporting records once while calculating both chosen periods", () => {
    const result = investigate({ ...query, comparison: query.period }, [row("both")], context);
    expect(result.groups[0]).toMatchObject({ currentMinor: "100", comparisonMinor: "100", deltaMinor: "0", currentCount: 1, comparisonCount: 1, supportCount: 1 });
    expect(result.records.total).toBe(1);
  });
  it("names exclusion reasons correctly for non-default status and kind queries", () => {
    const rows = [row("posted"), { ...row("transfer"), kind: "transfer" as const }, { ...row("pending"), status: "pending" as const }];
    const result = investigate({ ...query, statuses: ["pending"], kinds: ["transfer"] }, rows, context);
    expect(result.coverage).toMatchObject({ statusExcluded: 2, postedExcluded: 2, pendingExcluded: 0, kindExcluded: 1, transferExcluded: 0 });
  });
});

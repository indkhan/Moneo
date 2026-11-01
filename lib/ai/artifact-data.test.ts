import { describe, expect, it } from "vitest";
import { ARTIFACT_FRAME_CSP, artifactDocument, artifactQueriesSchema, checkQueries, resolveQueryInput, resolveToken } from "./artifact-data";

describe("artifact data", () => {
  it("puts the CSP and escaped data before the generated page", () => {
    const doc = artifactDocument("<html><head><title>x</title></head><body></body></html>", { note: "</script><b>" });
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<title>"));
    expect(doc).not.toContain("</script><b>");
    expect(doc).toContain("\\u003c/script>");
    expect(artifactDocument("<p>hi</p>", {})).toMatch(/^<meta[^>]+Content-Security-Policy/);
  });

  it("loads the app theme and the Moneo kit, defaulting to a page that follows the OS", () => {
    const dark = artifactDocument("<p>hi</p>", {}, { theme: "dark" });
    expect(dark).toContain("color-scheme:dark");
    expect(dark).toContain("--moneo-accent:");
    expect(dark).toContain(".m-card{");
    expect(artifactDocument("<p>hi</p>", {})).toContain("color-scheme:light dark");
  });

  it("keeps a directly opened frame sandboxed and frameable only by the app", () => {
    expect(ARTIFACT_FRAME_CSP).toContain("sandbox allow-scripts");
    expect(ARTIFACT_FRAME_CSP).not.toContain("allow-same-origin");
    expect(ARTIFACT_FRAME_CSP).toContain("frame-ancestors 'self'");
  });

  it("accepts only known sources and unique names, and checks each input once its dates are resolved", () => {
    expect(artifactQueriesSchema.safeParse([{ name: "bal", source: "balances", input: {} }]).success).toBe(true);
    expect(artifactQueriesSchema.safeParse([{ name: "x", source: "sql", input: {} }]).success).toBe(false);
    expect(artifactQueriesSchema.safeParse([{ name: "a", source: "accounts" }, { name: "a", source: "goals" }]).success).toBe(false);
    expect(checkQueries([{ name: "cf", source: "cashflow", input: { from: "nope", to: "@today", currencyCode: "EUR" } }], "2026-11-01")).toHaveLength(1);
    expect(checkQueries([{ name: "cf", source: "cashflow", input: { from: "@month_start", to: "@today", currencyCode: "EUR" } }], "2026-11-01")).toEqual([]);
  });

  it("keeps a saved period's meaning: this month stays the calendar month, literal dates stay fixed", () => {
    const input = { period: { from: "@month_start", to: "@month_end" }, last: { from: "@month_start:-1", to: "@month_end:-1" }, fixed: "2026-04-27", note: "@unknown" };
    expect(resolveQueryInput(input, "2026-03-15")).toEqual({ period: { from: "2026-03-01", to: "2026-03-31" }, last: { from: "2026-02-01", to: "2026-02-28" }, fixed: "2026-04-27", note: "@unknown" });
    expect(resolveQueryInput({ from: "@days_ago:29", to: "@today", y: "@year_start", w: "@week_start" }, "2026-11-04")).toEqual({ from: "2026-10-06", to: "2026-11-04", y: "2026-01-01", w: "2026-11-02" });
    expect(resolveToken("@year_end:-1", "2026-11-04")).toBe("2025-12-31");
  });

  it("fills params and drops page cursors, since they pin an old evidence set", () => {
    const params = { values: { account: "acc-1" }, ranges: { month: { from: "2026-09-01", to: "2026-09-30" } } };
    expect(resolveQueryInput({ accountId: "@param:account", period: { from: "@param:month.from", to: "@param:month.to" }, page: { size: 20, cursor: "abc" } }, "2026-11-01", params))
      .toEqual({ accountId: "acc-1", period: { from: "2026-09-01", to: "2026-09-30" }, page: { size: 20 } });
    expect(() => resolveToken("@param:missing", "2026-11-01", params)).toThrow("Unknown param");
  });
});

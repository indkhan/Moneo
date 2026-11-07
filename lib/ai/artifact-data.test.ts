import { describe, expect, it } from "vitest";
import { artifactDocument, artifactFrameCsp, artifactQueriesSchema, checkQueries, offeredQueriesSchema, offeredSources, resolveQueryInput, resolveToken } from "./artifact-data";

describe("artifact data", () => {
  it("offers Scalable sources only with a connection, and live-only ones only with live data on", () => {
    const scalable = (access: "snapshot" | "live" | null) => offeredSources(access).filter(source => source.startsWith("scalable_"));
    expect(scalable(null)).toEqual([]);
    expect(scalable("snapshot")).toEqual(["scalable_portfolio", "scalable_activity", "scalable_watchlist"]);
    expect(scalable("live")).toEqual(["scalable_portfolio", "scalable_activity", "scalable_watchlist", "scalable_security"]);
    expect(offeredQueriesSchema(null).safeParse([{ name: "p", source: "scalable_portfolio" }]).success).toBe(false);
    // A saved card keeps loading after Scalable is disconnected; its query then reports an error.
    expect(artifactQueriesSchema.safeParse([{ name: "p", source: "scalable_portfolio" }]).success).toBe(true);
  });

  const origin = "http://localhost:3000";
  // The generated page is the inner frame's srcdoc; this reads it back as the browser would.
  const inner = (doc: string) => /srcdoc="([^"]*)"/.exec(doc)![1].replace(/&quot;/g, '"').replace(/&amp;/g, "&");

  it("puts the CSP and escaped data before the generated page, inside a sandboxed inner frame", () => {
    const doc = artifactDocument("<html><head><title>x</title></head><body></body></html>", { note: "</script><b>" }, { origin });
    expect(doc).toContain('<iframe title="Artifact page" sandbox="allow-scripts" srcdoc="');
    const page = inner(doc);
    expect(page.indexOf("Content-Security-Policy")).toBeLessThan(page.indexOf("<title>"));
    expect(page).not.toContain("</script><b>");
    expect(page).toContain("\\u003c/script>");
    expect(inner(artifactDocument("<p>hi</p>", {}, { origin }))).toMatch(/^<meta[^>]+Content-Security-Policy/);
  });

  it("shows a page's script error on the page instead of leaving it blank", () => {
    const page = inner(artifactDocument("<body><script>broken(</script></body>", {}, { origin }));
    const guard = page.indexOf('addEventListener("error"');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(page.indexOf("broken("));
    expect(page).toContain("textContent");
  });

  it("loads the app theme and the Moneo kit, defaulting to a page that follows the OS", () => {
    const dark = inner(artifactDocument("<p>hi</p>", {}, { theme: "dark", origin }));
    expect(dark).toContain("color-scheme:dark");
    // Plain colours, so chart libraries can read them.
    expect(dark).toContain("--moneo-accent:#cbf26b");
    expect(dark).not.toContain("light-dark(");
    expect(dark).toContain(".m-card{");
    expect(inner(artifactDocument("<p>hi</p>", {}, { origin }))).toContain("color-scheme:light dark");
  });

  it("loads chart libraries from Moneo, never a CDN, and blocks every navigation of the page", () => {
    const page = inner(artifactDocument('<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"></script>', {}, { origin }));
    expect(page).toContain(`<script src="${origin}/artifact-lib/echarts.min.js">`);
    expect(page).not.toContain("jsdelivr");
    const csp = artifactFrameCsp(origin);
    expect(csp).toContain(`script-src 'unsafe-inline' ${origin}/artifact-lib/;`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("sandbox allow-scripts;");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("frame-ancestors 'self'");
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

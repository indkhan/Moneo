import { describe, expect, it } from "vitest";
import { ARTIFACT_FRAME_CSP, artifactDocument, artifactQueriesSchema, rollQueryDates } from "./artifact-data";

describe("artifact data", () => {
  it("puts the CSP and escaped data before the generated page", () => {
    const doc = artifactDocument("<html><head><title>x</title></head><body></body></html>", { note: "</script><b>" });
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<title>"));
    expect(doc).not.toContain("</script><b>");
    expect(doc).toContain("\\u003c/script>");
    expect(artifactDocument("<p>hi</p>", {})).toMatch(/^<meta[^>]+Content-Security-Policy/);
  });

  it("tells the page its view and the app theme, defaulting to a full page that follows the OS", () => {
    const widget = artifactDocument("<p>hi</p>", {}, { view: "widget", theme: "dark" });
    expect(widget).toContain('window.MONEO_VIEW="widget"');
    expect(widget).toContain("color-scheme:dark");
    expect(widget).toContain("--moneo-accent:");
    const page = artifactDocument("<p>hi</p>", {});
    expect(page).toContain('window.MONEO_VIEW="page"');
    expect(page).toContain("color-scheme:light dark");
  });

  it("keeps a directly opened frame sandboxed and frameable only by the app", () => {
    expect(ARTIFACT_FRAME_CSP).toContain("sandbox allow-scripts");
    expect(ARTIFACT_FRAME_CSP).not.toContain("allow-same-origin");
    expect(ARTIFACT_FRAME_CSP).toContain("frame-ancestors 'self'");
  });

  it("accepts only known sources with valid input and unique names", () => {
    expect(artifactQueriesSchema.safeParse([{ name: "bal", source: "balances", input: {} }]).success).toBe(true);
    expect(artifactQueriesSchema.safeParse([{ name: "x", source: "sql", input: {} }]).success).toBe(false);
    expect(artifactQueriesSchema.safeParse([{ name: "cf", source: "cashflow", input: { from: "nope" } }]).success).toBe(false);
    expect(artifactQueriesSchema.safeParse([{ name: "a", source: "accounts" }, { name: "a", source: "goals" }]).success).toBe(false);
  });
  it("moves saved from/to dates forward, nested or top level, and leaves other strings alone", () => {
    const input = { period: { from: "2026-04-27", to: "2026-10-27" }, groupKey: "2026-04-27", note: "2026-04-27", to: "2026-05-01", list: [{ from: "2026-01-31" }] };
    expect(rollQueryDates(input, 3)).toEqual({ period: { from: "2026-04-30", to: "2026-10-30" }, groupKey: "2026-04-27", note: "2026-04-27", to: "2026-05-04", list: [{ from: "2026-02-03" }] });
    expect(input.period.from).toBe("2026-04-27");
  });

  it("drops page cursors, since they pin the old evidence set", () => {
    const input = { period: { from: "2026-04-27", to: "2026-10-27" }, page: { size: 20, cursor: "abc" } };
    expect(rollQueryDates(input, 1)).toEqual({ period: { from: "2026-04-28", to: "2026-10-28" }, page: { size: 20 } });
    expect(input.page.cursor).toBe("abc");
  });

  it("returns an unchanged copy when no days have passed", () => {
    const input = { period: { from: "2026-04-27", to: "2026-10-27" }, page: { size: 20, cursor: "abc" } };
    expect(rollQueryDates(input, 0)).toEqual(input);
    expect(rollQueryDates(input, 0)).not.toBe(input);
  });
});

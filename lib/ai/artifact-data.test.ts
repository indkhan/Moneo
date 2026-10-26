import { describe, expect, it } from "vitest";
import { ARTIFACT_FRAME_CSP, artifactDocument, artifactQueriesSchema } from "./artifact-data";

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
});

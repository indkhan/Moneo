import { describe, expect, it } from "vitest";
import { artifactDocument, artifactQueriesSchema } from "./artifact-data";

describe("artifact data", () => {
  it("puts the CSP and escaped data before the generated page", () => {
    const doc = artifactDocument("<html><head><title>x</title></head><body></body></html>", { note: "</script><b>" });
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<title>"));
    expect(doc).not.toContain("</script><b>");
    expect(doc).toContain("\\u003c/script>");
    expect(artifactDocument("<p>hi</p>", {})).toMatch(/^<meta[^>]+Content-Security-Policy/);
  });

  it("accepts only known sources with valid input and unique names", () => {
    expect(artifactQueriesSchema.safeParse([{ name: "bal", source: "balances", input: {} }]).success).toBe(true);
    expect(artifactQueriesSchema.safeParse([{ name: "x", source: "sql", input: {} }]).success).toBe(false);
    expect(artifactQueriesSchema.safeParse([{ name: "cf", source: "cashflow", input: { from: "nope" } }]).success).toBe(false);
    expect(artifactQueriesSchema.safeParse([{ name: "a", source: "accounts" }, { name: "a", source: "goals" }]).success).toBe(false);
  });
});

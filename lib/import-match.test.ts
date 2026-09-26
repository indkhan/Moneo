import { describe, expect, it } from "vitest";
import { decideImportMatch } from "./import-match";

describe("overlapping imports", () => {
  it("matches only one stable external ID", () => {
    expect(decideImportMatch("ref-1", [{ id: "old", externalId: "ref-1" }])).toEqual({ action: "matched", transactionId: "old" });
    expect(decideImportMatch("ref-1", [{ id: "corrected", externalId: "ref-1" }, { id: "different" }])).toEqual({ action: "matched", transactionId: "corrected" });
  });

  it("holds fingerprint-only and conflicting external IDs for review", () => {
    expect(decideImportMatch(undefined, [{ id: "old" }])).toEqual({ action: "review" });
    expect(decideImportMatch("ref-1", [{ id: "old", externalId: "ref-1" }, { id: "other", externalId: "ref-1" }])).toEqual({ action: "review" });
  });

  it("accepts repeated identical rows in one file because caller supplies only earlier imports", () => {
    expect(decideImportMatch(undefined, [])).toEqual({ action: "new" });
  });

  it("never merges pending and posted", () => {
    expect(decideImportMatch("ref-1", [{ id: "old", externalId: "ref-1", status: "posted" }], "pending")).toEqual({ action: "review" });
    expect(decideImportMatch("ref-1", [{ id: "old", externalId: "ref-1", status: "pending" }], "pending")).toEqual({ action: "matched", transactionId: "old" });
    expect(decideImportMatch(undefined, [{ id: "old", status: "posted" }], "pending")).toEqual({ action: "review" });
    expect(decideImportMatch(undefined, [], "pending")).toEqual({ action: "new" });
  });
});

import { describe, expect, it } from "vitest";
import { decideImportMatch, decideOccurrence } from "@/lib/import/match";

describe("rows with no bank id, in a bank's complete answer", () => {
  const posted = (id: string) => ({ id, status: "posted" });
  it("matches what the ledger has, however often the row was imported before", () => {
    expect(decideOccurrence("posted", { index: 1, total: 1 }, [posted("t"), posted("t"), posted("t")])).toEqual({ action: "matched", transactionId: "t" });
    expect(decideOccurrence("posted", { index: 1, total: 2 }, [posted("b"), posted("a")])).toEqual({ action: "matched", transactionId: "a" });
    expect(decideOccurrence("posted", { index: 2, total: 2 }, [posted("b"), posted("a")])).toEqual({ action: "matched", transactionId: "b" });
  });
  it("lets a genuine second identical payment land", () => {
    expect(decideOccurrence("posted", { index: 1, total: 2 }, [posted("t")])).toEqual({ action: "matched", transactionId: "t" });
    expect(decideOccurrence("posted", { index: 2, total: 2 }, [posted("t")])).toEqual({ action: "new" });
    expect(decideOccurrence("posted", { index: 1, total: 1 }, [])).toEqual({ action: "new" });
  });
  it("sends anything unclear to review", () => {
    expect(decideOccurrence("posted", { index: 1, total: 1 }, [posted("a"), posted("b")])).toEqual({ action: "review" });
    expect(decideOccurrence("posted", { index: 1, total: 1 }, [{ id: "a", status: "pending" }])).toEqual({ action: "review" });
  });
  it("every occurrence count ends with exactly what the bank states, for any overlap", () => {
    for (let stated = 1; stated <= 5; stated++) for (let inLedger = 0; inLedger <= stated; inLedger++) {
      const candidates = Array.from({ length: inLedger }, (_, index) => posted(`t${index}`));
      const decisions = Array.from({ length: stated }, (_, index) => decideOccurrence("posted", { index: index + 1, total: stated }, candidates));
      expect(decisions.filter(item => item.action === "new")).toHaveLength(stated - inLedger);
      expect(new Set(decisions.flatMap(item => item.action === "matched" ? [item.transactionId] : [])).size).toBe(inLedger);
    }
  });
});

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

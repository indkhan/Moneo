import { describe, expect, it } from "vitest";
import { findOwnTransfers, normalizeIban, sourceIbans, type TransferCandidate } from "./own-transfers";

const CURRENT = "DE89370400440532013000", SAVINGS = "DE02120300000000202051", ELSEWHERE = "DE75512108001245126199";
const row = (id: string, accountId: string, amount: bigint, postedOn = "2026-10-01", extra: Partial<TransferCandidate> = {}): TransferCandidate =>
  ({ id, version: 1, accountId, postedOn, amountMinor: amount, currencyCode: "EUR", reviewReasons: [], ibans: [], ...extra });
const own = { tracked: new Map([[CURRENT, "current"], [SAVINGS, "savings"]]), untracked: new Map([[ELSEWHERE, "elsewhere-id"]]) };

describe("findOwnTransfers", () => {
  it("pairs legs when a source row names the other own account's IBAN", () => {
    const result = findOwnTransfers([row("out", "current", -50000n, "2026-10-01", { ibans: [CURRENT, SAVINGS] }), row("in", "savings", 50000n, "2026-10-02")], own);
    expect(result).toEqual({ pairs: [{ outId: "out", inId: "in" }], single: [] });
  });

  it("prefers the closest dated IBAN-proven leg", () => {
    const result = findOwnTransfers([row("out", "current", -100n, "2026-10-05", { ibans: [SAVINGS] }), row("far", "savings", 100n, "2026-10-02"), row("near", "savings", 100n, "2026-10-05")], own);
    expect(result.pairs).toEqual([{ outId: "out", inId: "near" }]);
  });

  it("never pairs without IBAN evidence, even when the statement calls it a transfer", () => {
    expect(findOwnTransfers([row("out", "current", -100n), row("in", "savings", 100n)], own).pairs).toEqual([]);
    expect(findOwnTransfers([row("out", "current", -100n, "2026-10-01", { reviewReasons: ["source_transfer"] }), row("in", "savings", 100n, "2026-10-01", { reviewReasons: ["source_transfer"] })], own).pairs).toEqual([]);
  });

  it("never pairs within one account, across currencies, beyond the window or unequal amounts", () => {
    const out = row("out", "current", -100n, "2026-10-01", { ibans: [SAVINGS] });
    for (const into of [row("in", "current", 100n), row("in", "savings", 100n, "2026-10-01", { currencyCode: "USD" }), row("in", "savings", 100n, "2026-10-05"), row("in", "savings", 99n)])
      expect(findOwnTransfers([out, into], own).pairs).toEqual([]);
  });

  it("marks one leg sent to an own account Moneo doesn't track", () => {
    expect(findOwnTransfers([row("out", "current", -100n, "2026-10-01", { ibans: [CURRENT, ELSEWHERE] })], own).single).toEqual([{ transactionId: "out", identifierId: "elsewhere-id" }]);
  });

  it("marks a lone leg to a tracked own account by IBAN when its other side is not in Moneo", () => {
    expect(findOwnTransfers([row("out", "current", -100n, "2026-10-01", { ibans: [SAVINGS] })], own).single).toEqual([{ transactionId: "out", iban: SAVINGS }]);
  });

  it("leaves a leg alone when its counterpart account holds the opposite amount nearby", () => {
    const out = row("out", "current", -100n, "2026-10-01", { ibans: [SAVINGS] });
    const legs = [out, row("in", "savings", 100n, "2026-10-03")];
    expect(findOwnTransfers([out], own, legs).single).toEqual([]);
    expect(findOwnTransfers([out], own, [out, row("late", "savings", 100n, "2026-10-09")]).single).toEqual([{ transactionId: "out", iban: SAVINGS }]);
  });
});

describe("IBAN parsing", () => {
  it("normalizes spacing and case and reads every IBAN-shaped source value", () => {
    expect(normalizeIban("de89 3704 0044 0532 0130 00")).toBe(CURRENT);
    expect(normalizeIban("Rent October")).toBeNull();
    expect(sourceIbans({ counterparty_iban: SAVINGS, description: "Savings", amount: "-5" })).toEqual([SAVINGS]);
  });
});

import { describe, expect, it } from "vitest";
import { cashWithdrawals } from "./own-transfers";
import { findOwnTransfers, normalizeIban, ownNameSuggestions, sourceIbans, type TransferCandidate } from "./own-transfers";

const CURRENT = "DE89370400440532013000", SAVINGS = "DE02120300000000202051", ELSEWHERE = "DE75512108001245126199";
const row = (id: string, accountId: string, amount: bigint, postedOn = "2026-10-01", extra: Partial<TransferCandidate> = {}): TransferCandidate =>
  ({ id, version: 1, accountId, postedOn, amountMinor: amount, currencyCode: "EUR", reviewReasons: [], ibans: [], ...extra });
const own = { tracked: new Map([[CURRENT, "current"], [SAVINGS, "savings"]]), untracked: new Map([[ELSEWHERE, "elsewhere-id"]]) };

describe("findOwnTransfers", () => {
  it("pairs legs when a source row names the other own account's IBAN", () => {
    const result = findOwnTransfers([row("out", "current", -50000n, "2026-10-01", { ibans: [CURRENT, SAVINGS] }), row("in", "savings", 50000n, "2026-10-02")], own);
    expect(result).toEqual({ pairs: [{ outId: "out", inId: "in" }], single: [], named: [] });
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

describe("own money without an IBAN", () => {
  const withdrawal = row("atm", "current", -5000n, "2026-10-01", { text: "Commerzbank 00210404/Faktoreistr./S 2025-10-16T17:03:36 KFN 0 VJ 2812 Bargeldauszahlung" });
  const deposit = row("deposit", "current", 60000n, "2026-10-01", { text: "BARGELDEINZAHLUNG KARTE 0 EINZAHLAUTOMAT 210404" });
  const broker = row("broker", "current", 170000n, "2026-10-01", { text: "Scalable Capital Broker withdrawal", counterparty: "Scalable Capital GmbH" });

  it("moves cash machine withdrawals and deposits to cash", () => {
    expect(findOwnTransfers([withdrawal, deposit], own).named).toEqual([{ transactionId: "atm", account: "cash" }, { transactionId: "deposit", account: "cash" }]);
  });

  it("treats Scalable Capital as an own account only when Scalable is connected", () => {
    expect(findOwnTransfers([broker], own).named).toEqual([]);
    expect(findOwnTransfers([broker], own, [broker], { scalable: true }).named).toEqual([{ transactionId: "broker", account: "scalable" }]);
  });

  it("leaves ordinary spending and refunds of cash-back shops alone", () => {
    const shop = row("shop", "current", -2000n, "2026-10-01", { text: "AUFLADUNG MENSA UNI SAAR", counterparty: "Mensa" });
    const credit = row("credit", "current", 2707n, "2026-10-01", { text: "Strom AUSZAHLUNG GUTHABEN", counterparty: "VATTENFALL EUROPE SALES" });
    expect(findOwnTransfers([shop, credit], own, undefined, { scalable: true }).named).toEqual([]);
  });

  it("prefers IBAN evidence over a name rule", () => {
    const deposit = row("in", "current", -80000n, "2026-10-01", { ibans: [ELSEWHERE], text: "stocks", counterparty: "Scalable Capital GmbH" });
    const result = findOwnTransfers([deposit], own, undefined, { scalable: true });
    expect(result.single).toEqual([{ transactionId: "in", identifierId: "elsewhere-id" }]);
    expect(result.named).toEqual([]);
  });
});

describe("ownNameSuggestions", () => {
  const proven = row("proven", "current", -80000n, "2026-03-06", { ibans: [ELSEWHERE], counterparty: "Usman Khan" });
  const old = row("old", "current", 150000n, "2025-08-18", { counterparty: "USMAN  KHAN", text: "main Usman Khan main End-to-End-Ref.: NOTPROVIDED" });

  it("ignores rows where the bank put the owner's own name on someone else's payment", () => {
    // Revolut names the account holder as counterparty on card refunds; the description names the shop.
    const refund = row("refund", "current", 3653n, "2025-11-14", { counterparty: "USMAN KHAN", text: "Refund from temu.com" });
    expect(ownNameSuggestions([refund], [proven], own)).toEqual([]);
  });

  it("suggests payments from a name already seen on a transfer to an own IBAN", () => {
    expect(ownNameSuggestions([old], [proven], own)).toEqual([{ transactionId: "old", name: "Usman Khan" }]);
  });

  it("never learns a name from a payment to someone else's IBAN, or suggests without a learned name", () => {
    const stranger = row("stranger", "current", -1000n, "2026-03-06", { ibans: ["DE44500105175407324931"], counterparty: "Usman Khan" });
    expect(ownNameSuggestions([old], [stranger], own)).toEqual([]);
    expect(ownNameSuggestions([row("other", "current", 100n, "2026-01-01", { counterparty: "Saad Malick", text: "Saad Malick" })], [proven], own)).toEqual([]);
  });

  it("skips rows that already have an answer", () => {
    expect(ownNameSuggestions([old], [proven], own, new Set(["old"]))).toEqual([]);
  });
});

describe("IBAN parsing", () => {
  it("normalizes spacing and case and reads every IBAN-shaped source value", () => {
    expect(normalizeIban("de89 3704 0044 0532 0130 00")).toBe(CURRENT);
    expect(normalizeIban("Rent October")).toBeNull();
    expect(sourceIbans({ counterparty_iban: SAVINGS, description: "Savings", amount: "-5" })).toEqual([SAVINGS]);
  });
});

describe("cash machine withdrawals", () => {
  const row = (over = {}) => ({ id: "a", postedOn: "2026-11-01", amountMinor: -10000n, text: "Bargeldauszahlung Sparkasse", transferId: null, ...over });
  it("offers a card for each recent withdrawal, once", () => {
    expect(cashWithdrawals([row()], "2026-11-08").map(item => item.id)).toEqual(["a"]);
    expect(cashWithdrawals([row()], "2026-11-08", new Set(["a"]))).toEqual([]);
  });
  it("leaves out deposits, other wording, linked rows and old withdrawals", () => {
    expect(cashWithdrawals([row({ amountMinor: 100n }), row({ text: "Coffee" }), row({ transferId: "b" }), row({ postedOn: "2026-09-01" })], "2026-11-08")).toEqual([]);
  });
});

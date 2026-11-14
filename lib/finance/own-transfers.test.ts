import { describe, expect, it } from "vitest";
import { cashWithdrawals } from "./own-transfers";
import { findExchanges, findOwnTransfers, internalMoves, normalizeIban, ownNameSuggestions, sourceIbans, uncertainPairs, withBankContext, type TransferCandidate } from "./own-transfers";
import type { RawContext } from "@/lib/bank/raw-context";

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

  it("pairs a closing row with the bank's row in the account it names, even days apart", () => {
    const closing = row("out", "old", -100n, "2026-10-20", { closingTo: "savings" });
    expect(findOwnTransfers([closing, row("in", "savings", 100n, "2026-10-01")], own).pairs).toEqual([{ outId: "out", inId: "in" }]);
    for (const other of [row("in", "current", 100n, "2026-10-19"), row("in", "savings", 99n, "2026-10-19"), row("in", "savings", 100n, "2026-09-01")])
      expect(findOwnTransfers([closing, other], own).pairs).toEqual([]);
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

describe("bank context", () => {
  const ctx = (over: Partial<RawContext> = {}): RawContext => ({ bank_id: null, payment_type: "transfer", bank_code: null, bank_sub_code: null, mcc: null, counterparty_name: null,
    counterparty_iban: null, counterparty_bic: null, counterparty_ids: [], own_side_ids: [], creditor_id: null, mandate_ref: null, instructed_amount: null,
    instructed_currency: null, exchange_rate: null, own_account: false, ...over });

  it("only proposes two unrelated equal opposite amounts across own accounts, never pairs them", () => {
    const rows = [row("rent", "current", -50000n, "2026-10-01"), row("salary", "savings", 50000n, "2026-10-02")];
    expect(findOwnTransfers(rows, own).pairs).toEqual([]);
    expect(uncertainPairs(rows)).toEqual([{ outId: "rent", inId: "salary" }]);
    // A third matching leg makes it ambiguous, and a row with someone else's IBAN is never a candidate.
    expect(uncertainPairs([...rows, row("gift", "other", 50000n, "2026-10-02")])).toEqual([]);
    expect(uncertainPairs([rows[0], { ...rows[1], raw: ctx({ counterparty_iban: "DE44500105175407324931", counterparty_name: "Example Employer" }) }])).toEqual([]);
  });

  it("pairs a leg whose bank context names an own IBAN, and marks an unpaired top-up as a transfer", () => {
    const out = row("out", "current", -100n, "2026-10-01"), into = row("in", "savings", 100n, "2026-10-01");
    const raw = new Map([["out", ctx({ counterparty_iban: "DE02 1203 0000 0000 2020 51", own_account: true })]]);
    expect(findOwnTransfers(withBankContext([out, into], raw), own).pairs).toEqual([{ outId: "out", inId: "in" }]);
    const topUp = withBankContext([row("top", "current", -2500n, "2026-10-01")], new Map([["top", ctx({ payment_type: "top_up", counterparty_iban: SAVINGS, own_account: true })]]));
    expect(findOwnTransfers(topUp, own).single).toEqual([{ transactionId: "top", iban: SAVINGS }]);
  });

  it("pairs a leg sent to the bank's id for another own account", () => {
    const ownWithIds = { ...own, ids: new Map([["acct-savings", "savings"]]) };
    const out = row("out", "current", -100n, "2026-10-01", { raw: ctx({ counterparty_ids: [{ identification: "acct-savings" }] }) });
    expect(findOwnTransfers([out, row("in", "savings", 100n, "2026-10-01")], ownWithIds).pairs).toEqual([{ outId: "out", inId: "in" }]);
  });

  it("leaves a proven leg alone when two other sides are equally close", () => {
    const out = row("out", "current", -100n, "2026-10-02", { ibans: [SAVINGS] });
    expect(findOwnTransfers([out, row("a", "savings", 100n, "2026-10-01"), row("b", "savings", 100n, "2026-10-03")], own).pairs).toEqual([]);
  });

  it("keeps a card paid in a foreign currency as spending", () => {
    const card = row("card", "current", -2300n, "2026-10-01", { raw: ctx({ payment_type: "card", counterparty_name: "Example Shop", instructed_amount: "25.00", instructed_currency: "USD", exchange_rate: "1.087" }) });
    expect(findExchanges([card])).toEqual({ pairs: [], single: [] });
  });

  it("pairs exchange legs in two currencies and never invents a missing one", () => {
    const eur = row("eur", "eur-wallet", -10000n, "2026-10-01", { raw: ctx({ payment_type: "exchange", instructed_amount: "108.70", instructed_currency: "USD" }) });
    const usd = row("usd", "usd-wallet", 10870n, "2026-10-01", { currencyCode: "USD", raw: ctx({ payment_type: "unknown" }) });
    expect(findExchanges([eur, usd])).toEqual({ pairs: [{ outId: "eur", inId: "usd" }], single: [] });
    // The bank's stated foreign amount must match the other side, and a lone leg is marked on its own.
    expect(findExchanges([eur, { ...usd, amountMinor: 9999n }])).toEqual({ pairs: [], single: ["eur"] });
    expect(findExchanges([eur])).toEqual({ pairs: [], single: ["eur"] });
  });

  it("groups moves with nobody on the other side into one question per description", () => {
    const moves = [row("a", "current", -2000n, "2026-10-01", { text: "To EUR MB:1234", raw: ctx({ payment_type: "unknown" }), identityId: "id-1" }),
      row("b", "current", 2000n, "2026-10-05", { text: "To EUR MB:5678", raw: ctx({ payment_type: "unknown" }), identityId: "id-1" }),
      row("c", "current", -500n, "2026-10-06", { text: "To EUR", raw: ctx({ payment_type: "unknown" }) }),
      row("d", "current", -900n, "2026-10-06", { text: "Rent October", raw: ctx({ counterparty_name: "Example Landlord", counterparty_iban: "DE44500105175407324931" }) })];
    // "To EUR" only went one way and has no transfer code, so it isn't asked about.
    expect(internalMoves(moves)).toEqual([{ key: "to eur mb", transactionIds: ["a", "b"], identityId: "id-1" }]);
    expect(internalMoves([{ ...moves[2], raw: ctx({ payment_type: "top_up" }) }])).toEqual([{ key: "to eur", transactionIds: ["c"], identityId: null }]);
  });
});

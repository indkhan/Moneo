import { resolveBalances } from "@/lib/finance/balances";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { inspectRows, parseCsv } from "@/lib/import/csv";
import { batchDecisions } from "@/lib/import/batch";
import { bankStatement, preferredBalance, bankObservation } from "./statement";
import type { BankTransaction } from "./enable-banking";

const tx = (over: Partial<BankTransaction>): BankTransaction => ({
  entry_reference: "ref-1", transaction_amount: { currency: "EUR", amount: "12.30" }, credit_debit_indicator: "DBIT",
  status: "BOOK", booking_date: "2026-10-01", creditor: { name: "REWE Markt" }, remittance_information: ["REWE SAGT DANKE", "1234"], ...over,
});
const account = { accountName: "Revolut ••1234", currencyCode: "EUR", calendarTimezone: "Europe/Berlin" };
const mapped = (transactions: BankTransaction[]) => {
  const statement = bankStatement(transactions, account)!;
  return inspectRows(parseCsv(statement.csv), statement.mapping).mapped;
};

describe("bank statement mapping", () => {
  it("maps to exact integer minor units with explicit currency and sign", () => {
    const rows = mapped([
      tx({}),
      tx({ entry_reference: "ref-2", credit_debit_indicator: "CRDT", transaction_amount: { currency: "EUR", amount: "2500.01" }, debtor: { name: "Employer GmbH" }, remittance_information: [] }),
      tx({ entry_reference: "ref-3", credit_debit_indicator: "DBIT", transaction_amount: { currency: "EUR", amount: "-0.07" } }),
      tx({ entry_reference: "ref-4", credit_debit_indicator: null, transaction_amount: { currency: "JPY", amount: "-1500" }, booking_date: "2026-10-02",
        balance_after_transaction: { currency: "JPY", amount: "98500" } }),
    ]);
    expect(rows.map(row => [row.externalId, row.amountMinor, row.currencyCode, row.postedOn, row.status])).toEqual([
      ["ref-1", -1230n, "EUR", "2026-10-01", "posted"],
      ["ref-2", 250001n, "EUR", "2026-10-01", "posted"],
      ["ref-3", -7n, "EUR", "2026-10-01", "posted"],
      ["ref-4", -1500n, "JPY", "2026-10-02", "posted"],
    ]);
    expect(typeof rows[0].amountMinor).toBe("bigint");
    expect(rows[0].description).toBe("REWE SAGT DANKE 1234");
    expect(rows[0].merchant).toBe("REWE Markt");
    expect(rows[1].description).toBe("Employer GmbH");
    expect(rows[3].balanceMinor).toBe(98500n);
  });

  it("drops pending rows, dedupes repeated ids and falls back to transaction_id", () => {
    const rows = mapped([tx({}), tx({}), tx({ entry_reference: "p", status: "PDNG" }), tx({ entry_reference: null, transaction_id: "tid" })]);
    expect(rows.map(row => row.externalId)).toEqual(["ref-1", "tid"]);
    expect(bankStatement([tx({ status: "PDNG" })], account)).toBeNull();
  });

  it("is idempotent: syncing the same data twice yields one import, overlaps match by bank id", () => {
    const first = bankStatement([tx({}), tx({ entry_reference: "ref-2" })], account)!;
    const again = bankStatement([tx({ entry_reference: "ref-2" }), tx({})], account)!;
    const hash = (csv: string) => createHash("sha256").update(csv).digest("hex");
    // Same bytes → same file_hash → the imports unique index returns the existing import.
    expect(hash(again.csv)).toBe(hash(first.csv));
    // A later, overlapping window carries the same external ids, so the import pipeline matches
    // every already-imported row instead of inserting it again.
    const decisions = batchDecisions([
      { rowNumber: 2, hasExternalId: true, status: "posted", candidates: [{ id: "t1", stableExternalMatch: true, status: "posted", version: 1 }] },
      { rowNumber: 3, hasExternalId: true, status: "posted", candidates: [] },
    ]);
    expect(decisions.map(decision => decision.action)).toEqual(["matched", "new"]);
  });

  it("saves the bank's balance apart from the rows, so it survives no rows, a row in review or a row dated tomorrow", () => {
    const now = new Date("2026-10-05T09:30:00Z");
    const closing = { balance_type: "CLBD", reference_date: "2026-10-02", balance_amount: { currency: "EUR", amount: "-40.50" } };
    expect(bankObservation([closing], "EUR", now, "Europe/Berlin")).toEqual({ amountMinor: "-4050", balanceType: "CLBD", asOf: "2026-10-01T22:00:00.000Z" });
    // Today's booked balance, and one with no date, describe the moment of the fetch.
    expect(bankObservation([{ ...closing, balance_type: "ITBD", reference_date: "2026-10-05" }], "EUR", now, "Europe/Berlin")).toMatchObject({ balanceType: "ITBD", asOf: now.toISOString() });
    expect(bankObservation([{ ...closing, reference_date: null }], "EUR", now, "Europe/Berlin")).toMatchObject({ asOf: now.toISOString() });
    expect(bankObservation([], "EUR", now, "Europe/Berlin")).toBeNull();
    // The statement itself no longer carries it, so its bytes only change when rows do.
    const statement = bankStatement([tx({ booking_date: "2026-10-05" })], account)!;
    expect(inspectRows(parseCsv(statement.csv), statement.mapping).mapped[0].balanceMinor).toBeUndefined();
  });

  it("never dates an available balance as an earlier closing balance, so a hold can't count twice", () => {
    const available = (amount: string) => ({ balance_type: "CLAV", reference_date: "2026-10-04", balance_amount: { currency: "EUR", amount } });
    const account = { id: "bank", name: "Bank", currency_code: "EUR" };
    // Monday: 100.00 booked with a 30.00 card hold, so 70.00 available. Tuesday: the hold books, 70.00 is still available.
    const monday = bankObservation([available("70.00")], "EUR", new Date("2026-10-05T09:00:00Z"), "UTC")!;
    const tuesday = bankObservation([available("70.00")], "EUR", new Date("2026-10-06T09:00:00Z"), "UTC")!;
    const snapshot = (row: typeof monday, id: string) => ({ id, account_id: "bank", amount_minor: row.amountMinor, currency_code: "EUR", as_of: row.asOf, provenance: `bank:${row.balanceType}`, balance_type: row.balanceType });
    const hold = { id: "hold", account_id: "bank", amount_minor: "-3000", currency_code: "EUR", posted_on: "2026-10-06", status: "posted" };
    expect(resolveBalances([account], [snapshot(monday, "m"), snapshot(tuesday, "t")], [hold], "2026-10-06T12:00:00Z", "UTC")[0].balance.amount_minor).toBe("7000");
  });

  it("prefers a booked balance in the account currency, falling back to an available one", () => {
    const balance = (type: string, amount: string, currency = "EUR") => ({ balance_type: type, balance_amount: { currency, amount } });
    expect(preferredBalance([balance("ITBD", "5"), balance("CLBD", "4"), balance("CLBD", "9", "USD")], "EUR")?.balance_amount.amount).toBe("4");
    expect(preferredBalance([balance("ITAV", "1"), balance("CLBD", "2")], "EUR")?.balance_amount.amount).toBe("2");
    expect(preferredBalance([balance("OTHR", "3"), balance("ITAV", "1")], "EUR")?.balance_amount.amount).toBe("1");
    expect(preferredBalance([balance("OTHR", "1")], "EUR")).toBeUndefined();
    expect(preferredBalance([balance("CLBD", "1", "USD")], "EUR")).toBeUndefined();
  });
});

// Changing the CSV bytes would re-import every window as new rows and orphan rules keyed on the description (the dedupe hash
// is the CSV's). The raw-data sidecar must never touch it: this is the exact output for an invented three-page response
// with every extra Enable Banking field, taken before the sidecar existed.
describe("statement bytes are frozen", () => {
  const extra = { bank_transaction_code: { code: "CARD_PAYMENT", sub_code: "POS" }, merchant_category_code: "5411", note: "n", exchange_rate: { exchange_rate: "1.1" },
    creditor_agent: { bic_fi: "ABNANL2A" }, debtor_account_additional_identification: [{ identification: "card-1" }], reference_number: "R1" };
  const pages: BankTransaction[][] = [
    [tx({ entry_reference: "b2", booking_date: "2026-10-02", transaction_amount: { currency: "EUR", amount: "4.50" }, ...extra }),
      tx({ entry_reference: "a1", booking_date: "2026-10-01", credit_debit_indicator: "CRDT", transaction_amount: { currency: "EUR", amount: "1200.00" }, debtor: { name: "Employer GmbH" }, debtor_account: { iban: "DE89 3704 0044 0532 0130 00" }, remittance_information: ["Salary", "October"] }),
      tx({ entry_reference: "p1", status: "PDNG" })],
    [tx({ entry_reference: "b2", booking_date: "2026-10-02", transaction_amount: { currency: "EUR", amount: "4.50" } }),
      tx({ entry_reference: null, transaction_id: "t3", booking_date: null, value_date: "2026-10-03", creditor: { name: "  Cafe   Luna " }, remittance_information: [], balance_after_transaction: { currency: "EUR", amount: "99.50" } })],
    [tx({ entry_reference: null, transaction_id: null, booking_date: "2026-10-03", creditor: null, remittance_information: null, credit_debit_indicator: null, transaction_amount: { currency: "EUR", amount: "-0.10" } }),
      tx({ entry_reference: "c4", booking_date: "2026-10-03", transaction_amount: { currency: "EUR", amount: "7.00" }, remittance_information: ["Gläubiger-ID: DE98ZZZ09999999999", "Mandatsref: M1"] })],
  ];
  const GOLDEN = [
    "id,date,description,amount,currency,balance,counterparty,counterparty_iban",
    "a1,2026-10-01,Salary October,1200.00,EUR,,Employer GmbH,DE89370400440532013000",
    "b2,2026-10-02,REWE SAGT DANKE 1234,-4.50,EUR,,REWE Markt,",
    ",2026-10-03,Bank transaction,-0.10,EUR,,,",
    "c4,2026-10-03,Gläubiger-ID: DE98ZZZ09999999999 Mandatsref: M1,-7.00,EUR,,REWE Markt,",
    "t3,2026-10-03,Cafe Luna,-12.30,EUR,99.50,Cafe Luna,",
  ].join("\n");

  it("produces the same CSV and file hash as before", () => {
    const statement = bankStatement(pages.flat(), account)!;
    expect(statement.csv).toBe(GOLDEN);
    expect(createHash("sha256").update(statement.csv).digest("hex")).toBe("e0a1dcc69d4b8cd1962e2f7b15341bc548d6e109fa82311848d9a3f4c7a2165d");
  });

  it("names the bank transaction behind every CSV row, in order", () => {
    const statement = bankStatement(pages.flat(), account)!;
    expect(statement.sources).toHaveLength(statement.rowCount);
    // CSV row number i + 2 (the header is row 1) is sources[i]: identified rows by their bank id.
    const ids = parseCsv(statement.csv).map(row => row.id);
    statement.sources.forEach((source, index) => expect(source.entry_reference ?? source.transaction_id ?? "").toBe(ids[index]));
  });
});

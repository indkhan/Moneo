import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { inspectRows, parseCsv } from "@/lib/import/csv";
import { batchDecisions } from "@/lib/import/batch";
import { bankStatement, preferredBalance } from "./statement";
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

  it("attaches the closing balance to the latest booked row only when it covers it", () => {
    const closing = { balance_type: "CLBD", reference_date: "2026-10-02", balance_amount: { currency: "EUR", amount: "-40.50" } };
    const statement = bankStatement([tx({ entry_reference: "b", booking_date: "2026-10-02" }), tx({})], account, closing)!;
    const rows = inspectRows(parseCsv(statement.csv), statement.mapping).mapped;
    expect(rows.map(row => row.balanceMinor)).toEqual([undefined, -4050n]);
    const stale = bankStatement([tx({ booking_date: "2026-10-03" })], account, closing)!;
    expect(inspectRows(parseCsv(stale.csv), stale.mapping).mapped[0].balanceMinor).toBeUndefined();
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

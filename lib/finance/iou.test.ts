import { describe, expect, it } from "vitest";
import { iouName, iouRecord, parseIouName, repaymentMatches, settledRecord, type IouItem } from "./iou";

const lent: IouItem = { id: "i1", kind: "asset", name: "Lent to Mohammed", currency_code: "EUR", amount_minor: "50000", as_of: "2026-10-01", version: 1, removed_at: null, linked_account_id: null };
const owed: IouItem = { id: "i2", kind: "debt", name: "Owed to Sara", currency_code: "EUR", amount_minor: "-20000", as_of: "2026-10-01", version: 1, removed_at: null, linked_account_id: null };
const txn = (id: string, description: string, amount_minor: string, posted_on = "2026-10-10", currency_code = "EUR") => ({ id, description, amount_minor, currency_code, posted_on });

describe("iou naming and records", () => {
  it("round-trips the person through the name", () => {
    expect(parseIouName(iouName("lent", "Mohammed Ali"))).toEqual({ direction: "lent", person: "Mohammed Ali" });
    expect(parseIouName("Savings")).toBeNull();
  });
  it("saves lent money as an asset and borrowed money as a zero-interest debt", () => {
    expect(iouRecord({ direction: "lent", person: "Mohammed", amountMinor: "50000", currencyCode: "EUR", date: "2026-10-26" })).toMatchObject({ kind: "asset", amount_minor: "50000", annual_rate_text: null });
    expect(iouRecord({ direction: "borrowed", person: "Sara", amountMinor: "20000", currencyCode: "EUR", date: "2026-10-26" })).toMatchObject({ kind: "debt", amount_minor: "-20000", annual_rate_text: "0", monthly_payment_minor: "0" });
  });
});

describe("repaymentMatches", () => {
  it("matches money in from the borrower, partial or full", () => {
    expect(repaymentMatches([lent], [txn("t1", "SEPA Credit MOHAMMED ALI rent", "48000")])).toEqual([{ itemId: "i1", transactionId: "t1", appliedMinor: "48000", person: "Mohammed", direction: "lent", owedMinor: "50000" }]);
    expect(repaymentMatches([lent], [txn("t1", "Mohammed", "70000")])[0].appliedMinor).toBe("50000");
  });
  it("matches money out to the lender for a debt", () => {
    expect(repaymentMatches([owed], [txn("t2", "Transfer to sara", "-10000")])[0]).toMatchObject({ itemId: "i2", appliedMinor: "10000" });
  });
  it("ignores wrong direction, currency, earlier dates, other names and name fragments", () => {
    expect(repaymentMatches([lent, owed], [txn("a", "Mohammed", "-48000"), txn("b", "Sara", "10000"), txn("c", "Mohammed", "48000", "2026-09-30"),
      txn("d", "Mohammed", "48000", "2026-10-10", "USD"), txn("e", "Mohammedan Bakery", "48000"), txn("f", "Landlord", "48000")])).toEqual([]);
  });
  it("sends a transaction to the closest open IOU", () => {
    const second = { ...lent, id: "i3", amount_minor: "10000" };
    expect(repaymentMatches([lent, second], [txn("t", "Mohammed", "9500")])[0].itemId).toBe("i3");
  });
  it("skips removed and settled items", () => {
    expect(repaymentMatches([{ ...lent, removed_at: "2026-10-05T00:00:00Z" }, { ...owed, amount_minor: "0" }], [txn("t", "Mohammed", "100"), txn("u", "Sara", "-100")])).toEqual([]);
  });
});

describe("settledRecord", () => {
  it("reduces what is left and keeps its direction", () => {
    expect(settledRecord({ ...lent, annual_rate_text: null, monthly_payment_minor: null }, "48000", "2026-10-26")).toMatchObject({ kind: "asset", amount_minor: "2000", as_of: "2026-10-26" });
    expect(settledRecord({ ...owed, annual_rate_text: "0", monthly_payment_minor: "0" }, "5000", "2026-10-26")).toMatchObject({ kind: "debt", amount_minor: "-15000" });
  });
  it("returns null when fully repaid", () => {
    expect(settledRecord({ ...lent, annual_rate_text: null, monthly_payment_minor: null }, "50000", "2026-10-26")).toBeNull();
  });
});

import { expect, it } from "vitest";
import { isBankWindow, waitingRepeats, type StagedRow } from "./repeats";

const row = (over: Partial<StagedRow> = {}): StagedRow => ({ sourceId: "s", importId: "i", status: "review", accountId: "bank", postedOn: "2026-11-02", amountMinor: "-35500", description: "Rent", currencyCode: "EUR", rowStatus: "posted", externalId: null, ...over });
const ledger = (id: string, over = {}) => ({ id, account_id: "bank", posted_on: "2026-11-02", amount_minor: "-35500", description: "Rent", currency_code: "EUR", status: "posted", ...over });

it("resolves rows that repeat what the ledger already has, across any number of overlapping syncs", () => {
  const rows = [row({ sourceId: "a", importId: "first" }), row({ sourceId: "b", importId: "second" }), row({ sourceId: "c", importId: "third" })];
  expect(waitingRepeats(rows, [ledger("t")]).map(item => item.sourceId)).toEqual(["a", "b", "c"]);
});

it("leaves a possible second payment waiting: one import stating more than the ledger has", () => {
  const rows = [row({ sourceId: "a" }), row({ sourceId: "b" })];
  expect(waitingRepeats(rows, [ledger("t")])).toEqual([]);
  expect(waitingRepeats(rows, [ledger("t"), ledger("u")]).map(item => item.sourceId)).toEqual(["a", "b"]);
  // Rows already decided in that import still count as what the bank stated.
  expect(waitingRepeats([row({ sourceId: "a" }), row({ sourceId: "b", status: "new" })], [ledger("t")])).toEqual([]);
});

it("needs the same day, amount, description, currency and account, a posted ledger row, and no bank id", () => {
  for (const other of [ledger("t", { posted_on: "2026-11-03" }), ledger("t", { amount_minor: "-35501" }), ledger("t", { description: "Other" }), ledger("t", { currency_code: "USD" }), ledger("t", { account_id: "else" }), ledger("t", { status: "pending" })])
    expect(waitingRepeats([row()], [other])).toEqual([]);
  expect(waitingRepeats([row({ externalId: "bank-id" })], [ledger("t")])).toEqual([]);
  expect(waitingRepeats([row({ rowStatus: "pending" })], [ledger("t")])).toEqual([]);
});

it("only trusts bank windows, new or old", () => {
  expect(isBankWindow({ filename: "x.csv", mapping: { completeWindow: true } })).toBe(true);
  expect(isBankWindow({ filename: "Bank ••1 bank sync 2026-11-08.csv", mapping: { externalIdColumn: "id" } })).toBe(true);
  expect(isBankWindow({ filename: "statement.csv", mapping: { externalIdColumn: "id" } })).toBe(false);
  expect(isBankWindow({ filename: "Bank ••1 bank sync 2026-11-08.csv", mapping: {} })).toBe(false);
});

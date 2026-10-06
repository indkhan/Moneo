import { expect, it } from "vitest";
import { reconcileOccurrence } from "./recurring-occurrences";
const item = { id: "a", account_id: "cash", amount_minor: "-10000", currency_code: "EUR" };
const row = { id: "t", account_id: "cash", amount_minor: "-4000", currency_code: "EUR", posted_on: "2026-10-04", status: "posted", kind: "ordinary", review_reasons: [] };
const receipt = { account_id: "cash", amount_minor: "-4000", currency_code: "EUR", kind: "ordinary", review_reasons: [] };
const link = { id: "s", assumption_id: "a", scheduled_on: "2026-10-06", transaction_id: "t", completes_occurrence: false, receipt, undone_at: null };
it("keeps only the remainder after an explicitly associated early partial posting", () => {
  expect(reconcileOccurrence(item, "2026-10-06", [link], [row], "2026-10-06T12:00:00Z", "2026-10-06")).toEqual([{ date: "2026-10-06", amountMinor: -6000n, observed: false }]);
});
it("closes a changed-amount full occurrence without guessing amount equality", () => {
  expect(reconcileOccurrence(item, "2026-10-06", [{ ...link, completes_occurrence: true }], [row], "2026-10-06T12:00:00Z", "2026-10-06")).toEqual([]);
});
it("projects a linked future late posting once while keeping the partial remainder due", () => {
  expect(reconcileOccurrence(item, "2026-10-06", [link], [{ ...row, posted_on: "2026-10-08" }], "2026-10-06T12:00:00Z", "2026-10-06")).toEqual([{ date: "2026-10-08", amountMinor: -4000n, observed: true }, { date: "2026-10-06", amountMinor: -6000n, observed: false }]);
});
it.each(["pending", "posted"])("counts a negative %s associated hold or posting once", status => {
  expect(reconcileOccurrence(item, "2026-10-06", [{ ...link, completes_occurrence: true }], [{ ...row, status }], "2026-10-06T12:00:00Z", "2026-10-06")).toEqual([]);
});
it("projects positive pending income instead of treating it as opening cash", () => {
  const income = { ...item, amount_minor: "10000" };
  const credit = { ...row, amount_minor: "12000", status: "pending" };
  expect(reconcileOccurrence(income, "2026-10-06", [{ ...link, completes_occurrence: true, receipt: { ...receipt, amount_minor: "12000" } }], [credit], "2026-10-06T12:00:00Z", "2026-10-06")).toEqual([{ date: "2026-10-06", amountMinor: 12000n, observed: true }]);
});
it.each(["undo", "reclassification", "amount change", "missing transaction"])("restores the obligation after %s", reason => {
  const links = [{ ...link, undone_at: reason === "undo" ? "2026-10-06T10:00:00Z" : null }];
  const rows = reason === "missing transaction" ? [] : [{ ...row, kind: reason === "reclassification" ? "transfer" : "ordinary", amount_minor: reason === "amount change" ? "-4500" : "-4000" }];
  expect(reconcileOccurrence(item, "2026-10-06", links, rows, "2026-10-06T12:00:00Z", "2026-10-06")).toEqual([{ date: "2026-10-06", amountMinor: -10000n, observed: false }]);
});
it("does not consume an unrelated identical posting", () => {
  expect(reconcileOccurrence(item, "2026-10-06", [], [{ ...row, amount_minor: "-10000" }], "2026-10-06T12:00:00Z", "2026-10-06")).toEqual([{ date: "2026-10-06", amountMinor: -10000n, observed: false }]);
});
it("uses the workspace calendar for an explicitly associated future booking timestamp", () => {
  expect(reconcileOccurrence(item, "2026-10-06", [{ ...link, completes_occurrence: true }], [{ ...row, posted_on: "2026-10-06", posted_at: "2026-10-06T22:30:00Z" }], "2026-10-06T12:00:00Z", "2026-10-06", "Europe/Berlin")).toEqual([{ date: "2026-10-07", amountMinor: -4000n, observed: true }]);
});
it("uses canonical settlement value while projecting verified additional fees as cash", () => {
  const result = reconcileOccurrence(item, "2026-10-06", [link], [{ ...row, posted_on: "2026-10-08", amount_minor: "-4400", canonical_amount_minor: "-4000" }], "2026-10-06T12:00:00Z", "2026-10-06");
  expect(result).toEqual([{ date: "2026-10-08", amountMinor: -4400n, observed: true }, { date: "2026-10-06", amountMinor: -6000n, observed: false }]);
});
it("compares jsonb receipts by fields rather than serialized key order", () => {
  const reordered = { kind: "ordinary", review_reasons: [], currency_code: "EUR", amount_minor: "-4000", account_id: "cash" };
  expect(reconcileOccurrence(item, "2026-10-06", [{ ...link, receipt: reordered }], [row], "2026-10-06T12:00:00Z", "2026-10-06")).toEqual([{ date: "2026-10-06", amountMinor: -6000n, observed: false }]);
});
it("consumes a pending debit by the same booked-date criterion as opening holds", () => {
  expect(reconcileOccurrence(item, "2026-10-06", [{ ...link, completes_occurrence: true }], [{ ...row, status: "pending", posted_on: "2026-10-06", posted_at: "2026-10-07T08:00:00Z" }], "2026-10-06T12:00:00Z", "2026-10-06")).toEqual([]);
});
it("projects a future booked-date pending debit not deducted from opening holds", () => {
  expect(reconcileOccurrence(item, "2026-10-06", [{ ...link, completes_occurrence: true }], [{ ...row, status: "pending", posted_on: "2026-10-08", posted_at: "2026-10-06T08:00:00Z" }], "2026-10-06T12:00:00Z", "2026-10-06")).toEqual([{ date: "2026-10-08", amountMinor: -4000n, observed: true }]);
});

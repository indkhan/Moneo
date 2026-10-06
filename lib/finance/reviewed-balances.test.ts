import { expect, it } from "vitest";
import { resolveBalances, type BalanceSnapshot, type BalanceTransaction } from "./balances";
const account = { id: "cash", name: "Synthetic cash", currency_code: "EUR" };
const row = { id: "morning", account_id: "cash", amount_minor: "-100", currency_code: "EUR", posted_on: "2026-10-06", posted_at: "2026-10-06T08:00:00Z", status: "posted" };
const snapshot = { id: "review", account_id: "cash", amount_minor: "10000", currency_code: "EUR", as_of: "2026-10-06T12:00:00Z", provenance: "manual" };
const reviewed = { ...snapshot, boundary_kind: "reviewed_activity", covered_transactions: [{ id: row.id, amount_minor: row.amount_minor, currency_code: "EUR", version: 0, posted_on: row.posted_on, posted_at: row.posted_at }] } as BalanceSnapshot;
const result = (s: BalanceSnapshot, rows: BalanceTransaction[] = [row]) => resolveBalances([account], [s], rows, "2026-10-06T14:00:00Z")[0].balance;
it("retains ambiguity when entering current booked balance without reviewed activity", () => {
  expect(result(snapshot)).toMatchObject({ status: "ambiguous", amount_minor: null });
});
it("covers reviewed timestamped activity and counts a later posting once", () => {
  expect(result(reviewed, [row, { ...row, id: "later", posted_at: "2026-10-06T13:00:00Z", amount_minor: "-250" }])).toMatchObject({ status: "current", amount_minor: "9750", reconciled_rows: 1 });
});
it("covers explicitly reviewed date-only activity without guessing uncovered same-day activity", () => {
  const dateOnly = { ...row, posted_at: undefined };
  const s = { ...reviewed, covered_transactions: [{ ...reviewed.covered_transactions![0], posted_at: null }] };
  expect(result(s, [dateOnly])).toMatchObject({ status: "current", amount_minor: "10000" });
  expect(result(s, [dateOnly, { ...dateOnly, id: "unreviewed" }])).toMatchObject({ status: "ambiguous", amount_minor: null });
});
it("invalidates covered evidence after corrections or removal rather than silently counting it twice", () => {
  expect(result(reviewed, [{ ...row, amount_minor: "-200" }]).status).toBe("ambiguous");
  expect(result(reviewed, []).status).toBe("ambiguous");
});
it("ignores undone reconciliation snapshots and retains conflicting boundary ambiguity", () => {
  const undone = { ...reviewed, undone_at: "2026-10-06T13:00:00Z" };
  expect(result(undone).status).toBe("missing");
  const s = { ...reviewed, covered_transactions: [] };
  expect(resolveBalances([account], [reviewed, s], [row], "2026-10-06T14:00:00Z")[0].balance.status).toBe("ambiguous");
});

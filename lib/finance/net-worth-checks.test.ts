import { describe, expect, it } from "vitest";
import { bankBalanceFindings, brokerFindings, checksNotice, historyBoundaryFindings, importFindings } from "./net-worth-checks";
import { calendarDayBoundary } from "./calendar";

const timeZone = "Europe/Berlin";
const accounts = [{ id: "bank", name: "Bank", currency_code: "EUR" }];
const closing = (date: string, amount_minor: string, balance_type = "CLBD", created_at = `${date}T23:00:00Z`) => ({ account_id: "bank", amount_minor, currency_code: "EUR", as_of: calendarDayBoundary(date, timeZone), provenance: `bank:${balance_type}`, balance_type, created_at });
const posted = (posted_on: string, amount_minor: string) => ({ id: `${posted_on}:${amount_minor}`, account_id: "bank", amount_minor, currency_code: "EUR", posted_on, status: "posted" });

describe("bank balances adding up", () => {
  it("stays quiet when two closing balances differ by exactly the postings between them", () => {
    expect(bankBalanceFindings(accounts, [closing("2026-10-01", "10000"), closing("2026-10-05", "8000")], [posted("2026-10-01", "-999"), posted("2026-10-03", "-2000"), posted("2026-10-06", "-1")], timeZone)).toEqual([]);
  });

  it("raises one finding per pair of balances, with the same key on every read", () => {
    const run = () => bankBalanceFindings(accounts, [closing("2026-10-01", "10000"), closing("2026-10-05", "8000")], [posted("2026-10-03", "-1500")], timeZone);
    expect(run()).toHaveLength(1);
    expect(run()[0]).toMatchObject({ key: "bank:bank:2026-10-01:2026-10-05", kind: "bank_balance" });
    expect(run().map(item => item.key)).toEqual(run().map(item => item.key));
  });

  it("compares only booked balances of one type at a clear point in the day", () => {
    const during = { ...closing("2026-10-05", "1"), as_of: "2026-10-05T09:30:00Z" };
    const available = closing("2026-10-05", "1", "CLAV");
    const typed = { ...closing("2026-10-05", "1"), balance_type: null };
    const otherType = closing("2026-10-05", "1", "ITBD");
    expect(bankBalanceFindings(accounts, [closing("2026-10-01", "10000"), during, available, typed, otherType], [], timeZone)).toEqual([]);
  });

  it("does not raise a negative balance, or an undone observation", () => {
    expect(bankBalanceFindings(accounts, [closing("2026-10-01", "-500"), closing("2026-10-05", "-700"), { ...closing("2026-10-07", "1"), undone_at: "2026-10-08T00:00:00Z" }], [posted("2026-10-03", "-200")], timeZone)).toEqual([]);
  });
});

describe("the broker's parts", () => {
  const portfolio = { currency: "EUR", totalMinor: "10000" };
  it("allows rounding and reports a real gap and anything unsupported", () => {
    expect(brokerFindings({ ...portfolio, differenceMinor: "100" })).toEqual([]);
    expect(brokerFindings({ ...portfolio, differenceMinor: "101" })).toMatchObject([{ key: "broker:parts" }]);
    expect(brokerFindings({ ...portfolio, unsupported: ["A short position in Fund"] })).toMatchObject([{ key: "broker:unsupported:A short position in Fund" }]);
    expect(brokerFindings(null)).toEqual([]);
  });
});

describe("calculated history meeting reality", () => {
  const last = { on_date: "2026-11-06", currency_code: "EUR", total_minor: "100000" };
  it("allows a day's market move and counts money moved on the boundary day", () => {
    expect(historyBoundaryFindings(last, { date: "2026-11-07", minor: 105000n })).toEqual([]);
    expect(historyBoundaryFindings(last, { date: "2026-11-07", minor: 160000n }, 60000n)).toEqual([]);
    expect(historyBoundaryFindings(last, { date: "2026-11-07", minor: 160000n })).toMatchObject([{ key: "history:2026-11-06", kind: "history_boundary" }]);
    expect(historyBoundaryFindings(null, { date: "2026-11-07", minor: 1n })).toEqual([]);
  });
});

describe("imports landing", () => {
  const row = (id: string, status: string, created_at: string) => ({ id, filename: `${id}.csv`, status, created_at, mapping: { accountName: "Bank" } });
  it("lists a failed import until a later one of that account lands", () => {
    expect(importFindings([row("a", "failed", "2026-11-01")])).toMatchObject([{ key: "import:a" }]);
    expect(importFindings([row("a", "failed", "2026-11-01"), row("b", "completed", "2026-11-02")])).toEqual([]);
    expect(importFindings([row("b", "completed", "2026-10-31"), row("a", "failed", "2026-11-01")])).toHaveLength(1);
  });
});

it("words Home's message so it only changes with the findings", () => {
  expect(checksNotice([])).toBeNull();
  expect(checksNotice([{ title: "One thing" }])).toBe("One thing");
  expect(checksNotice([{ title: "a" }, { title: "b" }])).toBe("2 things in your numbers don't add up.");
});

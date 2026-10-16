import { expect, it } from "vitest";
import { balanceTrend } from "./history";

const snap = (as_of: string, amount_minor: string, extra: object = {}) => ({ account_id: "a", currency_code: "EUR", provenance: "manual", as_of, amount_minor, ...extra });

it("keeps the last recorded balance per day, skips undone rows and anchors the window", () => {
  const rows = [
    snap("2026-01-01T10:00:00Z", "100"),
    snap("2026-03-01T10:00:00Z", "200"),
    snap("2026-03-01T18:00:00Z", "250"),
    snap("2026-03-02T10:00:00Z", "999", { undone_at: "2026-03-03T00:00:00Z" }),
    snap("2026-03-05T10:00:00Z", "300", { account_id: "other" }),
  ];
  expect(balanceTrend(rows, "a", "EUR", "UTC", "2026-02-01")).toEqual([
    { date: "2026-01-01", value: 100n }, { date: "2026-03-01", value: 250n },
  ]);
  expect(balanceTrend(rows, "a", "EUR", "UTC", "2026-02-01", { date: "2026-03-10", value: 240n }).at(-1)).toEqual({ date: "2026-03-10", value: 240n });
  expect(balanceTrend(rows, "a", "EUR", "UTC", "2026-04-01")).toEqual([{ date: "2026-03-01", value: 250n }]);
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAmountMinor } from "@/lib/csv";
import { expandSchedule } from "@/lib/finance/model";

describe("plan assumption controls", () => {
  it("excludes disabled assumptions from the forecast so a retry cannot silently re-enable them", () => {
    const disabled = expandSchedule(
      { account_id: "checking", amount_minor: "-10000", currency_code: "EUR", cadence: "monthly", starts_on: "2026-01-01", ends_on: null, enabled: false },
      "2026-02-01",
      30,
    );
    const enabled = expandSchedule(
      { account_id: "checking", amount_minor: "-10000", currency_code: "EUR", cadence: "monthly", starts_on: "2026-01-01", ends_on: null, enabled: true },
      "2026-02-01",
      30,
    );
    expect(disabled).toEqual([]);
    expect(enabled.length).toBeGreaterThan(0);
  });

  it("keeps exact minor units for edited assumption amounts", () => {
    expect(parseAmountMinor("-1200.00")).toBe(-120000n);
    expect(parseAmountMinor("0.01")).toBe(1n);
  });

  it("guards user-confirmed assumptions against inferred overwrites and deletes", () => {
    const sql = readFileSync(
      new URL("../../supabase/migrations/202609260019_assumption_edits.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toContain("source = 'user'");
    expect(sql).toContain("on delete set null");
    expect(sql).toMatch(/grant update, delete on public\.financial_assumptions/i);
  });
});

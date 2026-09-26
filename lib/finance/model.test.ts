import { describe, expect, it } from "vitest";
import { expandSchedule } from "./model";

describe("financial assumptions", () => {
  it("projects an old monthly payment into the current horizon and clamps month-end dates", () => {
    const events = expandSchedule({ account_id: "checking", amount_minor: "-10000", currency_code: "EUR", cadence: "monthly", starts_on: "2020-01-31", ends_on: null }, "2026-02-01", 60);
    expect(events.map(event => event.date)).toEqual(["2026-02-28", "2026-03-31"]);
    expect(events[0].conservativeMinor).toBe(-11000n);
  });
});

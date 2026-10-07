import { describe, expect, it } from "vitest";
import { expandSchedule } from "./model";

describe("financial assumptions", () => {
  it("projects an old monthly payment into the current horizon and clamps month-end dates", () => {
    const events = expandSchedule({ account_id: "checking", amount_minor: "-10000", currency_code: "EUR", cadence: "monthly", starts_on: "2020-01-31", ends_on: null }, "2026-02-01", 60);
    expect(events.map(event => event.date)).toEqual(["2026-02-28", "2026-03-31"]);
    expect(events[0].conservativeMinor).toBe(-11000n);
  });

  it("projects yearly cadence correctly", () => {
    const events = expandSchedule({ account_id: "checking", amount_minor: "-10000", currency_code: "EUR", cadence: "yearly", starts_on: "2020-01-15", ends_on: null }, "2026-02-01", 400);
    expect(events.map(event => event.date)).toEqual(["2027-01-15"]);
  });

  it("rolls Feb 29 to Feb 28 in non-leap years for yearly cadence", () => {
    const events = expandSchedule({ account_id: "checking", amount_minor: "-10000", currency_code: "EUR", cadence: "yearly", starts_on: "2020-02-29", ends_on: null }, "2025-01-01", 1200);
    expect(events.map(event => event.date)).toEqual(["2025-02-28", "2026-02-28", "2027-02-28", "2028-02-29"]);
  });

  it("returns no events when horizon ends before first yearly occurrence", () => {
    const events = expandSchedule({ account_id: "checking", amount_minor: "-10000", currency_code: "EUR", cadence: "yearly", starts_on: "2025-06-15", ends_on: null }, "2026-01-01", 30);
    expect(events).toEqual([]);
  });

  it("projects yearly occurrence when horizon includes the date", () => {
    const events = expandSchedule({ account_id: "checking", amount_minor: "-10000", currency_code: "EUR", cadence: "yearly", starts_on: "2025-06-15", ends_on: null }, "2026-01-01", 200);
    expect(events.map(event => event.date)).toEqual(["2026-06-15"]);
  });
});
it.each([
  { cadence: "biweekly", anchor: "2020-01-03", start: "2026-01-01", days: 45, expected: ["2026-01-09", "2026-01-23", "2026-02-06"] },
  { cadence: "quarterly", anchor: "2024-01-31", start: "2026-02-01", days: 200, expected: ["2026-04-30", "2026-07-31"] },
])("expands $cadence from the original calendar anchor with exact money", ({cadence, anchor, start, days, expected}) => {
  const events = expandSchedule({account_id: "cash", amount_minor: "-9007199254740993", currency_code: "EUR", cadence, starts_on: anchor, ends_on: null}, start, days);
  expect(events.map(event => event.date)).toEqual(expected);
  expect(events.every(event => event.expectedMinor === -9007199254740993n)).toBe(true);
});

it("preserves the quarterly calendar anchor after enabled-only edits make the schedule intentional", () => {
  const schedule={account_id:"cash",amount_minor:"-9007199254740993",currency_code:"EUR",cadence:"quarterly",starts_on:"2026-04-30",schedule_anchor_on:"2025-10-31",ends_on:null,source:"user",enabled:true};
  expect(expandSchedule(schedule,"2026-07-01",40).map(event=>event.date)).toEqual(["2026-07-31"]);
  expect(expandSchedule({...schedule,enabled:false},"2026-07-01",40)).toEqual([]);
});

it("uses a changed schedule's persisted replacement anchor instead of the prior inferred day", () => {
  const edited={account_id:"cash",amount_minor:"-9007199254740993",currency_code:"EUR",cadence:"quarterly",starts_on:"2026-05-15",schedule_anchor_on:"2026-05-15",ends_on:null,source:"user"};
  expect(expandSchedule(edited,"2026-08-01",31).map(event=>event.date)).toEqual(["2026-08-15"]);
  const cadenceEdit={...edited,cadence:"monthly",starts_on:"2026-04-30",schedule_anchor_on:"2026-04-30"};
  expect(expandSchedule(cadenceEdit,"2026-07-01",31).map(event=>event.date)).toEqual(["2026-07-30"]);
});

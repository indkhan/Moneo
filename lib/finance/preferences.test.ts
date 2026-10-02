import { expect, it } from "vitest";
import { expandSchedule } from "./model";
it("keeps minor-unit uncertainty conservative on expenses and exposes editable exact cases", () => {
  const item = { account_id: "cash", amount_minor: "-1", currency_code: "EUR", cadence: "once", starts_on: "2026-10-01", ends_on: null };
  expect(expandSchedule(item, "2026-10-01", 1, 1000)[0]).toMatchObject({ expectedMinor: -1n, conservativeMinor: -2n, optimisticMinor: 0n });
  expect(expandSchedule(item, "2026-10-01", 1, 0)[0]).toMatchObject({ expectedMinor: -1n, conservativeMinor: -1n, optimisticMinor: -1n });
});

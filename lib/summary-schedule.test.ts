import { expect, it } from "vitest";
import { dueSummaryPeriod } from "./summary-schedule";
import { DEFAULT_SETTINGS } from "./settings";

it("recovers a weekly period after the daily UTC poll missed Monday's local time", () => {
  const settings = { ...DEFAULT_SETTINGS, summary_cadence: "weekly" as const, summary_time: "09:00" };
  expect(dueSummaryPeriod(settings, new Date("2026-10-05T00:00:00Z"))).toBeNull();
  expect(dueSummaryPeriod(settings, new Date("2026-10-06T00:00:00Z"))).toEqual({ cadence: "weekly", periodStart: "2026-10-05" });
});

it("uses the workspace month rather than the UTC month and honors disabled scopes", () => {
  const settings = { ...DEFAULT_SETTINGS, timezone: "America/Los_Angeles", summary_cadence: "monthly" as const };
  expect(dueSummaryPeriod(settings, new Date("2026-10-01T00:00:00Z"))).toEqual({ cadence: "monthly", periodStart: "2026-09-01" });
  expect(dueSummaryPeriod({ ...settings, ai_data_scopes: [] }, new Date("2026-10-02T00:00:00Z"))).toBeNull();
  expect(dueSummaryPeriod(DEFAULT_SETTINGS, new Date("2026-10-02T00:00:00Z"))).toBeNull();
});

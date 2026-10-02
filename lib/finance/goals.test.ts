import { expect, it } from "vitest";
import { goalContributionProjection } from "./goals";

it("keeps reservations separate from recorded savings and projects exact month-end contributions", () => {
  expect(goalContributionProjection({ targetMinor: 10000n, savedMinor: 1000n, monthlyMinor: 3000n, startsOn: "2026-01-31" }, "2026-02-01")).toEqual({ remainingMinor: 9000n, completionDate: "2026-04-30", contributions: 3n });
});

it("does not invent completion without saved evidence or a positive contribution plan", () => {
  expect(goalContributionProjection({ targetMinor: 10000n, savedMinor: null, monthlyMinor: 3000n, startsOn: "2026-01-31" }, "2026-02-01").completionDate).toBeNull();
  expect(goalContributionProjection({ targetMinor: 10000n, savedMinor: 0n, monthlyMinor: 0n, startsOn: null }, "2026-02-01").completionDate).toBeNull();
});

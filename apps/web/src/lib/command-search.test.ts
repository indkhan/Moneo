import { expect, it } from "vitest";
import { naturalTransactionFilters } from "./command-search";
it("turns a last-month question into visible deterministic transaction filters", () => {
  expect(
    naturalTransactionFilters("show restaurants last month", new Date("2026-09-13T12:00:00Z")),
  ).toEqual({ q: "restaurants", dateFrom: "2026-08-01", dateTo: "2026-08-31" });
});
it("keeps arbitrary text as text and never treats it as a privileged filter", () => {
  expect(naturalTransactionFilters("workspaceId=foreign")).toEqual({ q: "workspaceId=foreign" });
});

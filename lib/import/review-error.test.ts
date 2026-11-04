import { expect, it } from "vitest";
import { reviewErrorMessage } from "./review-error";

it("keeps messages that already tell the person what to do", () => {
  expect(reviewErrorMessage("Link the internal transfer first")).toBe("Link the internal transfer first");
  expect(reviewErrorMessage("Release exceeds the outstanding pending debit")).toBe("Release exceeds the outstanding pending debit");
});

it("explains stale versions and unavailable accounts", () => {
  expect(reviewErrorMessage("Destination changed; review again")).toMatch(/Refresh the page/);
  expect(reviewErrorMessage("Row already resolved")).toMatch(/changed since the page loaded/);
  expect(reviewErrorMessage("Reviewed destination unavailable")).toMatch(/no longer available/);
});

it("never shows database or schema text", () => {
  for (const raw of ['duplicate key value violates unique constraint "x"', '[{"code":"invalid_type","path":["sourceId"]}]', "Normalize the reviewed original before acceptance"])
    expect(reviewErrorMessage(raw)).toBe("This decision could not be saved, and nothing changed. Refresh the page and try again.");
});

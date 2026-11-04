import { expect, it } from "vitest";
import { displayFormat } from "./display-format";

it("follows the locale for dates and money", () => {
  expect(displayFormat("en-GB").date("2026-11-04")).toBe("4 Nov 2026");
  expect(displayFormat("de-DE").longDate("2026-11-04")).toBe("4. November 2026");
  expect(displayFormat("en-GB").money(123456n, "EUR")).toBe("EUR 1234.56");
  expect(displayFormat("de-DE").money(123456n, "EUR")).toBe("EUR 1234,56");
});

it("keeps a calendar day fixed and shows a timestamp in the workspace timezone", () => {
  expect(displayFormat("en-GB", "America/New_York").date("2026-11-04")).toBe("4 Nov 2026");
  expect(displayFormat("en-GB", "America/New_York").date("2026-11-04T01:00:00Z")).toBe("3 Nov 2026");
  expect(displayFormat("en-GB", "Europe/Berlin").dateTime("2026-11-01T17:23:49+00:00")).toBe("1 Nov 2026, 18:23");
});

it("says how long ago, never in the future", () => {
  const now = "2026-11-04T12:00:00Z", { ago } = displayFormat("en-GB");
  expect(ago("2026-11-04T11:55:00Z", now)).toBe("5 minutes ago");
  expect(ago("2026-11-04T09:00:00Z", now)).toBe("3 hours ago");
  expect(ago("2026-11-03T12:00:00Z", now)).toBe("yesterday");
  expect(ago("2026-11-04T12:05:00Z", now)).toBe("this minute");
});

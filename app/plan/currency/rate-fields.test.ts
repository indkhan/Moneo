import { expect, it } from "vitest";
import { ratePreview } from "./rate-fields";

it("previews a rate in the destination currency's own precision", () => {
  expect(ratePreview("EUR", "USD", "1.08")).toBe("1 EUR = 1.08 USD, so EUR 100.00 shows as USD 108.00.");
  expect(ratePreview("EUR", "JPY", "160.5")).toBe("1 EUR = 160.5 JPY, so EUR 100.00 shows as JPY 16050.");
  expect(ratePreview("USD", "KWD", "0.3")).toBe("1 USD = 0.3 KWD, so USD 100.00 shows as KWD 30.000.");
});

it("says nothing until the rate is readable, and flags a same-currency pair", () => {
  expect(ratePreview("EUR", "USD", "1,08")).toBeNull();
  expect(ratePreview("EUR", "XXX", "1.08")).toBeNull();
  expect(ratePreview("EUR", "EUR", "1")).toBe("Choose two different currencies.");
});

import {expect, it} from "vitest";
import {forecastInput} from "./forecast-schema";

it("rejects invalid external funding text without throwing and keeps exact positive bigint bounds", () => {
  const parse = (amountMinor: unknown) => forecastInput.safeParse({funding: [{date: "2026-10-08", currencyCode: "EUR", fromAccountId: "savings", toAccountId: "checking", amountMinor}]});
  for (const amount of ["bad", "", "0", "-1", "1.5", "01", "9223372036854775808", "1".repeat(100), 1, null]) expect(parse(amount).success).toBe(false);
  for (const amount of ["1", "9007199254740993", "9223372036854775807"]) expect(parse(amount)).toMatchObject({success: true, data: {funding: [{amountMinor: amount}]}});
});

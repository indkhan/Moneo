import {expect, it} from "vitest";
import {wealthEvidence} from "./wealth";

const asset = {id: "asset", name: "Recorded asset", amount_minor: "9007199254740993", currency_code: "EUR", as_of: "2026-09-30", linked_account_id: null};
it("retains exact historical asset and debt observations without making them current", () => {
  const rows = [asset, {...asset, id: "debt", amount_minor: "-10000", as_of: "2026-09-29"}];
  const dated = wealthEvidence(rows, "2026-10-08", "observed");
  expect(dated.included.map(row => [row.id, row.amountMinor, row.asOf, row.provenance])).toEqual([
    ["asset", 9007199254740993n, "2026-09-30", "manual valuation"], ["debt", -10000n, "2026-09-29", "manual valuation"],
  ]);
  expect(dated.missingInputs).toEqual([]);
  expect(wealthEvidence(rows, "2026-10-08").included).toEqual([]);
  expect(wealthEvidence(rows, "2026-10-08").missingInputs).toHaveLength(2);
});

it("excludes future and linked valuations from dated reporting and preserves currencies", () => {
  const dated = wealthEvidence([asset, {...asset, id: "future", as_of: "2026-10-09"},
    {...asset, id: "linked", linked_account_id: "account"}, {...asset, id: "yen", amount_minor: "3", currency_code: "JPY"}], "2026-10-08", "observed");
  expect(dated.included.map(row => [row.id, row.currencyCode, row.amountMinor])).toEqual([["asset", "EUR", 9007199254740993n], ["yen", "JPY", 3n]]);
  expect(dated.excludedLinked).toEqual(["linked"]);
  expect(dated.missingInputs).toEqual(["valuation:future:future"]);
});

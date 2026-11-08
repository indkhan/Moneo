import {expect, it} from "vitest";
import {wealthEvidence} from "./wealth";

const asset = {id: "asset", name: "Recorded asset", amount_minor: "9007199254740993", currency_code: "EUR", as_of: "2026-09-30", linked_account_id: null};
it("counts exact older asset and debt values and names them as not from today", () => {
  const rows = [asset, {...asset, id: "debt", name: "Recorded debt", amount_minor: "-10000", as_of: "2026-09-29"}];
  const dated = wealthEvidence(rows, "2026-10-08");
  expect(dated.included.map(row => [row.id, row.amountMinor, row.asOf, row.provenance])).toEqual([
    ["asset", 9007199254740993n, "2026-09-30", "manual valuation"], ["debt", -10000n, "2026-09-29", "manual valuation"],
  ]);
  expect(dated.missingInputs).toEqual([]);
  expect(dated.outdated).toEqual([{id: "asset", name: "Recorded asset", asOf: "2026-09-30"}, {id: "debt", name: "Recorded debt", asOf: "2026-09-29"}]);
});

it("excludes future and linked valuations from dated reporting and preserves currencies", () => {
  const dated = wealthEvidence([asset, {...asset, id: "future", as_of: "2026-10-09"},
    {...asset, id: "linked", linked_account_id: "account"}, {...asset, id: "yen", amount_minor: "3", currency_code: "JPY"}], "2026-10-08");
  expect(dated.included.map(row => [row.id, row.currencyCode, row.amountMinor])).toEqual([["asset", "EUR", 9007199254740993n], ["yen", "JPY", 3n]]);
  expect(dated.excludedLinked).toEqual(["linked"]);
  expect(dated.missingInputs).toEqual(["valuation:future:future"]);
});

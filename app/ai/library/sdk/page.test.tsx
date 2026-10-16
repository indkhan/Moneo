import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import SdkReference from "./page";

it("documents the live contract: operations per kind and forbidden APIs", () => {
  const html = renderToStaticMarkup(<SdkReference />);
  expect(html).toContain("quickjs-calculator-v1");
  expect(html).toContain("spending, cashflow, balances, goals, forecast");
  expect(html).toContain("fetch/network is not allowed");
  expect(html).toContain("8,000 characters");
});

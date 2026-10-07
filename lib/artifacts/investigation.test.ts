import { expect, it } from "vitest";
import { checkManifest } from "./spec";

const investigation = { version: 1, period: { from: "2026-09-01", to: "2026-09-30" }, comparison: { from: "2026-08-01", to: "2026-08-31" }, groupBy: ["category", "merchant"] };
it("allows a validated investigation only under declared spending/cashflow permissions", () => {
  const manifest = { kind: "custom_comparison", runtime: "quickjs-calculator-v1", sdk: ["spending"], investigation };
  expect(checkManifest("custom_comparison", manifest, ["spending"]).errors).toEqual([]);
  expect(checkManifest("custom_comparison", { ...manifest, sdk: ["balances"] }, ["balances"]).errors).not.toEqual([]);
  expect(checkManifest("custom_comparison", { ...manifest, investigation: { ...investigation, period: { from: "2026-02-30", to: "2026-09-30" } } }, ["spending"]).errors).not.toEqual([]);
});

import { expect, it } from "vitest";
import { comparisonMinor, transferPrincipal } from "./verified-links";
it("compares exact FX evidence in either direction and retains explicit transfer fees", () => {
  expect(comparisonMinor(10000n,"EUR","USD",{ from_currency:"EUR",to_currency:"USD",rate_text:"1.1" })).toBe(11000n);
  expect(comparisonMinor(5500n,"USD","EUR",{ from_currency:"EUR",to_currency:"USD",rate_text:"1.1" })).toBe(5000n);
  expect(comparisonMinor(9007199254740993n,"EUR","EUR",null)).toBe(9007199254740993n);
  expect(transferPrincipal(-10100n,100n,"included")).toBe(10000n);
  expect(transferPrincipal(10900n,100n,"included")).toBe(11000n);
  expect(transferPrincipal(-10000n,100n,"additional")).toBe(10000n);
  expect(() => comparisonMinor(1n,"EUR","USD",null)).toThrow();
  expect(() => transferPrincipal(-100n,100n,"included")).toThrow();
});

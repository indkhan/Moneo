import { expect, it } from "vitest";
import { bpsToPercent, percentOf, percentToBps, positiveMinor } from "./ui";

it("converts percent input to exact basis points and back", () => {
  expect(percentToBps("10")).toBe(1000);
  expect(percentToBps(" 2.5 ")).toBe(250);
  expect(percentToBps("0.01")).toBe(1);
  expect(percentToBps("100")).toBe(10000);
  for (const bad of ["100.01", "-1", "1.234", "abc", "", "1e2"]) expect(() => percentToBps(bad)).toThrow();
  expect([1000, 250, 1, 0, 3333].map(bpsToPercent)).toEqual(["10", "2.5", "0.01", "0", "33.33"]);
});

it("converts decimal currency input to positive minor units", () => {
  expect(positiveMinor("400.00", "EUR")).toBe("40000");
  expect(positiveMinor("90071992547409.93", "EUR")).toBe("9007199254740993");
  expect(positiveMinor("500", "JPY")).toBe("500");
  for (const bad of ["0", "-1", "1.234", "bad", ""]) expect(positiveMinor(bad, "EUR")).toBeNull();
});

it("clamps progress shares", () => {
  expect(percentOf(50n, 200n)).toBe(25);
  expect(percentOf(300n, 200n)).toBe(100);
  expect(percentOf(-5n, 200n)).toBe(0);
  expect(percentOf(5n, 0n)).toBe(0);
});

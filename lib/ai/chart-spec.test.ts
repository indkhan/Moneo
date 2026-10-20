import { expect, it } from "vitest";
import { chartValue, parseChartSpec } from "./chart-spec";

it("accepts multi-series charts with per-series currency and the labels alias", () => {
  expect(parseChartSpec(JSON.stringify({ type: "bar", stacked: true, labels: ["Aug", "Sep"], series: [{ name: "Food", data: [10, 12.5], currency: "EUR" }, { name: "Rent", data: [800, null] }] })))
    .toMatchObject({ type: "bar", stacked: true, x: ["Aug", "Sep"], series: [{ currency: "EUR" }, { name: "Rent" }] });
});

it("rejects invalid, mismatched or oversized specs", () => {
  expect(parseChartSpec("not json")).toBeNull();
  expect(parseChartSpec(JSON.stringify({ type: "radar", series: [{ name: "a", data: [1] }] }))).toBeNull();
  expect(parseChartSpec(JSON.stringify({ type: "line", x: ["a"], series: [{ name: "a", data: [1, 2] }] }))).toBeNull();
  expect(parseChartSpec(JSON.stringify({ type: "pie", x: ["a"], series: [{ name: "a", data: [1] }, { name: "b", data: [1] }] }))).toBeNull();
  expect(parseChartSpec(JSON.stringify({ type: "bar", series: Array.from({ length: 13 }, (_, i) => ({ name: `s${i}`, data: [1] })) }))).toBeNull();
  expect(parseChartSpec(JSON.stringify({ type: "bar", series: [{ name: "a", data: [1], href: "https://x" }] }))).toBeNull();
});

it("formats values as text with their currency or unit", () => {
  expect(chartValue(1234.5, { currency: "EUR" })).toBe("EUR 1,234.5");
  expect(chartValue(3, { unit: "tx" })).toBe("3 tx");
  expect(chartValue(null, {})).toBe("–");
});

import { expect, it } from "vitest";
import { calculatorManifestSchema, checkStateCompatibility, normalizeCalculatorParams } from "./spec";
import { evaluateIsolated } from "./isolate";

const manifest = calculatorManifestSchema.parse({ kind: "custom_report", runtime: "quickjs-calculator-v1", sdk: [], params: {
  amount: { type: "number", default: 50, min: 0, max: 100 },
  reference: { type: "string", default: "00123", maxLength: 8 },
  costMinor: { type: "string", default: "9007199254740993" },
} });
it("restores incompatible saved values with the announced defaults, ignoring retired fields", () => {
  expect(checkStateCompatibility({ amount: 500 }, manifest).join(";")).toContain("default applies");
  expect(normalizeCalculatorParams(manifest, { amount: 500, reference: 123, retired: 1 }, "restore"))
    .toEqual({ amount: 50, reference: "00123", costMinor: "9007199254740993" });
});
it("preserves string references and exact monetary strings through execution", async () => {
  const params = normalizeCalculatorParams(manifest, { amount: 100, reference: "00007", costMinor: "9007199254740995" });
  expect(await evaluateIsolated('input => ({ numbers: { reference: input.params.reference, cost: String(BigInt(input.params.costMinor)) } })', { params }))
    .toEqual({ numbers: { reference: "00007", cost: "9007199254740995" } });
});
it("rejects incompatible edited inputs instead of executing or saving a fallback", () => {
  for (const state of [{ amount: 101 }, { amount: "50" }, { reference: "123456789" }, { costMinor: "1.5" }]) {
    expect(() => normalizeCalculatorParams(manifest, state)).toThrow(/Param/);
  }
});
it("keeps a generated trip default when legacy state is absent and checks actual saved cost", () => {
  const trip = calculatorManifestSchema.parse({ kind: "trip_planner", runtime: "quickjs-calculator-v1", sdk: [], params: { costMinor: { type: "number", default: 12000, min: 0, max: 20000 } } });
  expect(normalizeCalculatorParams(trip, {}, "restore")).toEqual({ costMinor: 12000 });
  expect(normalizeCalculatorParams(trip, { costMinor: 15000 }, "restore")).toEqual({ costMinor: 15000 });
  expect(normalizeCalculatorParams(trip, { costMinor: 90000 }, "restore")).toEqual({ costMinor: 12000 });
});
it("rejects unsafe numeric money defaults and accepts exact string money", () => {
  expect(calculatorManifestSchema.safeParse({ ...manifest, params: { costMinor: { type: "number", default: 9007199254740992 } } }).success).toBe(false);
  expect(calculatorManifestSchema.safeParse({ ...manifest, params: { amount: { type: "number", default: 0, min: 1 } } }).success).toBe(false);
});

it("validates explicit monetary units and rejects currencies the host cannot display", () => {
  expect(calculatorManifestSchema.safeParse({ ...manifest, params: { budget: { type: "string", default: "00050", unit: "minor", currency: "ZZZ" } } }).success).toBe(false);
  const explicit = calculatorManifestSchema.parse({ ...manifest, params: { budget: { type: "string", default: "00050", unit: "minor", currency: "JPY", min: 0, max: 100 } } });
  expect(normalizeCalculatorParams(explicit, { budget: "00100" })).toEqual({ budget: "00100" });
  expect(() => normalizeCalculatorParams(explicit, { budget: "00101" })).toThrow(/Param budget/);
});

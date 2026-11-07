import { describe, expect, it } from "vitest";
import { cardParamsSchema, resolveParams } from "./params";
import { compileCard } from "./sandbox";
import { localValues, rerunCard } from "./local";
import { checkCard } from "./render";

const savings = { kind: "number", name: "monthly", label: "Each month", min: 0, max: 100000, step: 5000, default: 20000, format: "money", currency: "EUR" } as const;
const context = { settings: { timezone: "UTC" }, workspace: { locale: "en" } } as never;
const CARD = `export default function Card({ data, params }) {
  const months = params.yearly ? 12 : 1;
  return <div><Kit.Param name="monthly" /><Kit.Param name="yearly" /><Kit.Money minor={(BigInt(data.goal.saved_minor) + BigInt(params.monthly) * BigInt(months)).toString()} currency="EUR" /></div>;
}`;

describe("card sliders and switches", { timeout: 20_000 }, () => {
  it("keep slider values on the slider's grid and never let them into a query", () => {
    const declared = cardParamsSchema.parse([savings, { kind: "toggle", name: "yearly", label: "Per year", default: false }]);
    const { resolved, state } = resolveParams(declared, { monthly: "12345", yearly: "true" }, "2026-11-07");
    expect(localValues(state)).toEqual({ monthly: 10000, yearly: true });
    expect(resolveParams(declared, { monthly: "-5", yearly: "maybe" }, "2026-11-07").state.map(param => param.value)).toEqual(["0", "false"]);
    expect(resolveParams(declared, { monthly: "1e9" }, "2026-11-07").state[0].value).toBe("100000");
    expect(resolved.values).toEqual({});
    expect(cardParamsSchema.safeParse([{ ...savings, default: 200000 }]).success).toBe(false);
    expect(cardParamsSchema.safeParse([{ ...savings, currency: undefined }]).success).toBe(false);
  });

  it("rerun the card with the data it already has, as the browser does when one moves", async () => {
    const declared = cardParamsSchema.parse([savings, { kind: "toggle", name: "yearly", label: "Per year", default: false }]);
    const { state } = resolveParams(declared, { monthly: "30000", yearly: "true" }, "2026-11-07");
    const tree = await rerunCard({ compiled: compileCard(CARD), data: { goal: { saved_minor: "100000" } }, values: {} }, state, "M", "c1");
    expect(JSON.stringify(tree)).toContain('"minor":"460000"');
  });

  it("refuse a card that breaks with a slider at one end", async () => {
    const declared = cardParamsSchema.parse([savings]);
    const fragile = `export default function Card({ params }) { if (params.monthly === 0) throw new Error("divide by zero"); return <div><Kit.Param name="monthly" /></div>; }`;
    expect((await checkCard(fragile, [], declared, context)).errors[0]).toMatch(/at their min .*divide by zero/);
  });
});

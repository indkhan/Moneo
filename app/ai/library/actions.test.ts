import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { saveCalculatorParams, saveTripState, saveDatedTripState } from "./actions";
import { buildCalculatorSnapshot } from "@/lib/artifacts/snapshot";
import { addTripDays, defaultTripScenario } from "@/lib/finance/trip-scenario";

const fixture = vi.hoisted(() => ({ version: 2, update: vi.fn(), filters: [] as [string, unknown][], state: { costMinor: 200 } as Record<string, unknown>, sdk: [] as string[], params: { costMinor: { type: "number", default: 100, min: 0, max: 100000 } } as Record<string, unknown> }));
vi.mock("@/lib/finance/model", () => ({ evaluatePlan: async (days: number) => ({ input: { startDate: "2026-10-07", horizonDays: days, currencyCode: "EUR", accounts: [{ id: "a", currencyCode: "EUR", balanceMinor: 100000n }], events: [] } }) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { id: "owned", display_currency: "EUR", timezone: "Europe/Berlin" }, supabase: { from: (table: string) => {
  const query = { select: () => query, eq: (key: string, value: unknown) => { fixture.filters.push([key, value]); return query; },
    single: async () => ({ data: table === "artifacts" ? { kind: "trip_planner", active_version_id: "active", permissions: ["forecast"] } : table === "artifact_versions" ? { manifest: { kind: "trip_planner", runtime: "quickjs-calculator-v1", sdk: fixture.sdk, params: fixture.params } } : { state: fixture.state, version: fixture.version }, error: null }),
    in: async () => ({ data: [{ id: "a" }, { id: "b" }], error: null }),
    update: (value: unknown) => { fixture.update(value); return query; }, maybeSingle: async () => ({ data: { version: fixture.version + 1 }, error: null }) };
  return query;
} } }) }));
beforeEach(() => { fixture.version = 2; fixture.update.mockClear(); fixture.filters = []; fixture.sdk = []; fixture.state = { costMinor: 200 }; fixture.params = { costMinor: { type: "number", default: 100, min: 0, max: 100000 } }; });
afterEach(() => vi.useRealTimers());
function form(version: string) { const form = new FormData(); Object.entries({ artifactId: "00000000-0000-4000-8000-000000000001", params: '{"costMinor":300}', costMinor: "300", expectedVersion: version }).forEach(([key,value]) => form.set(key,value)); return form; }
it.each([saveCalculatorParams, saveTripState])("rejects a draft based on revision A after revision B was saved", async save => {
  expect(await save(form("1"))).toEqual({ conflict: true });
  expect(fixture.update).not.toHaveBeenCalled();
});

it("saves the complete dated scenario against its submitted revision and preserves unrelated tool state", async () => {
  const scenario = defaultTripScenario(new Date().toISOString().slice(0, 10), "EUR", "a", 300n);
  const input = form("2"); input.set("scenario", JSON.stringify(scenario));
  expect(await saveDatedTripState(input)).toEqual({ saved: true, version: 3, value: scenario });
  expect(fixture.update).toHaveBeenCalledWith(expect.objectContaining({ state: { costMinor: 300, tripDate: scenario.startsOn, accountId: "a", tripScenario: scenario }, version: 3 }));
  fixture.update.mockClear();
  input.set("expectedVersion", "1");
  expect(await saveDatedTripState(input)).toEqual({ conflict: true }); expect(fixture.update).not.toHaveBeenCalled();
});
it("saves calculator edits into the same dated trip assumptions used by the native planner", async () => {
  const scenario = defaultTripScenario(new Date().toISOString().slice(0, 10), "EUR", "a", 200n);
  fixture.state = { costMinor: 200, tripScenario: scenario }; fixture.sdk = ["forecast"];
  await saveCalculatorParams(form("2"));
  expect(fixture.update).toHaveBeenCalledWith(expect.objectContaining({ state: { costMinor: 300, tripScenario: { ...scenario, payments: [{ ...scenario.payments[0], amountMinor: "300" }] } } }));
});
it("replaces saved generated date/account scalars when the native simple budget changes", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const old = defaultTripScenario(today, "EUR", "a", 200n);
  fixture.state = { costMinor: 200, tripDate: old.startsOn, accountId: "a", note: "retain" };
  const date = addTripDays(old.startsOn, 1);
  const scenario = { ...old, startsOn: date, endsOn: date, payments: [{ ...old.payments[0], date, accountId: "b", amountMinor: "9007199254740993" }] };
  const input = form("2"); input.set("scenario", JSON.stringify(scenario));
  await saveDatedTripState(input);
  expect(fixture.update).toHaveBeenCalledWith(expect.objectContaining({ state: { costMinor: "9007199254740993", tripDate: scenario.startsOn, accountId: "b", tripScenario: scenario, note: "retain" } }));
});
it.each([saveCalculatorParams, saveTripState])("saves against the submitted owned state revision", async save => {
  expect(await save(form("2"))).toEqual({ saved: true, version: 3, value: save === saveTripState ? "300" : { costMinor: 300 } });
  expect(fixture.update).toHaveBeenCalledWith(expect.objectContaining({ version: 3 }));
  expect(fixture.filters).toContainEqual(["workspace_id", "owned"]);
  expect(fixture.filters).toContainEqual(["version", 2]);
});
it.each([saveCalculatorParams, saveTripState])("requires the draft revision", async save => {
  const input = form("2"); input.delete("expectedVersion");
  await expect(save(input)).rejects.toThrow(); expect(fixture.update).not.toHaveBeenCalled();
});
it.each([saveCalculatorParams, saveTripState])("accepts the initial zero revision", async save => {
  fixture.version = 0;
  expect(await save(form("0"))).toEqual({ saved: true, version: 1, value: save === saveTripState ? "300" : { costMinor: 300 } });
  expect(fixture.filters).toContainEqual(["version", 0]);
});

// Actual SDK/snapshot evaluation; only auth/database and forecast source boundaries are synthetic.
it.each(["unrelated", "tripDate", "accountId"])("Save/reload preserves initial default headroom when forecast inputs omit cost: %s", async key => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
  fixture.sdk = ["forecast"]; fixture.state = {};
  const params = { [key]: key === "tripDate" ? "2026-10-15" : key === "accountId" ? "a" : "note" };
  fixture.params = { [key]: { type: "string", default: params[key] } };
  const before = await buildCalculatorSnapshot("synthetic", "trip_planner", { tripParams: params });
  const input = form("2"); input.set("params", JSON.stringify(params));
  await saveCalculatorParams(input);
  const saved = fixture.update.mock.lastCall![0].state;
  const after = await buildCalculatorSnapshot("synthetic", "trip_planner", { tripScenario: saved.tripScenario, tripParams: params });
  expect(after.snapshot).toEqual(before.snapshot);
  expect(after.snapshot.evaluatedCostMinor).toBe("90000");
});
it.each(["tripDate", "accountId"])("Save preserves current native scalar cost when manifest omits cost: %s", async key => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
  fixture.sdk = ["forecast"];
  const params = { [key]: key === "tripDate" ? "2026-10-15" : "a" };
  fixture.params = { [key]: { type: "string", default: params[key] } };
  const before = await buildCalculatorSnapshot("synthetic", "trip_planner", { costMinor: 200n, tripParams: params });
  const input = form("2"); input.set("params", JSON.stringify(params));
  await saveCalculatorParams(input);
  const saved = fixture.update.mock.lastCall![0].state;
  const after = await buildCalculatorSnapshot("synthetic", "trip_planner", { costMinor: 200n, tripScenario: saved.tripScenario, tripParams: params });
  expect(after.snapshot).toEqual(before.snapshot);
});

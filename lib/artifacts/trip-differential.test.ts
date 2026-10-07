import { afterEach, expect, it, vi } from "vitest";
import { buildCalculatorSnapshot } from "./snapshot";
import { FALLBACK_CALCULATORS } from "./templates";
import { evaluateIsolated } from "./isolate";
import { accountLiquidity, type ForecastInput } from "@/lib/finance/calculations";
import { defaultTripScenario, evaluateTripScenario } from "@/lib/finance/trip-scenario";
import { calculatorManifestSchema, normalizeCalculatorParams } from "./spec";
import { POST } from "@/app/api/artifacts/trip/route";
const fixture = vi.hoisted(() => ({ input: {} as ForecastInput, scenario: {} as unknown, manifest: {} as unknown }));
vi.mock("@/lib/finance/model", () => ({ evaluatePlan: async (days: number) => ({ input: { ...fixture.input, horizonDays: days } }) }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { id: "w", display_currency: "EUR", timezone: "Europe/Berlin" }, supabase: { from: (table: string) => {
  const query = { select: () => query, eq: () => query, single: async () => ({ data: { permissions: ["forecast"], active_version_id: "v" }, error: null }),
    maybeSingle: async () => ({ data: table === "artifacts" ? { kind: "trip_planner", active_version_id: "v" } : table === "artifact_state" ? { state: { tripScenario: fixture.scenario } } : { manifest: fixture.manifest }, error: null }) }; return query;
} } }) }));
afterEach(() => vi.useRealTimers());

it.each([true, false])("first-load parameters and the local preview use the same dated paying-account evidence (explicit account: %s)", async explicitAccount => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  fixture.input = { startDate: "2026-10-01", horizonDays: 30, currencyCode: "EUR", accounts: [{ id: "a", currencyCode: "EUR", balanceMinor: 100000n }, ...(explicitAccount ? [{ id: "b", currencyCode: "EUR", balanceMinor: 50000n }] : [])], events: [] };
  fixture.scenario = undefined;
  const params = { costMinor: 20000, tripDate: "2026-10-09", ...(explicitAccount ? { accountId: "b" } : {}) };
  fixture.manifest = { ...FALLBACK_CALCULATORS.trip_planner.manifest, params: { costMinor: { type: "number", default: 20000 }, tripDate: { type: "string", default: params.tripDate }, ...(explicitAccount ? { accountId: { type: "string", default: "b" } } : {}) } };
  // These are the normalized manifest defaults on a new calculator, before any local edits.
  const built = await buildCalculatorSnapshot("00000000-0000-4000-8000-000000000001", "trip_planner", { costMinor: 20000n, tripParams: params });
  expect(built.snapshot).toMatchObject({ tripDate: "2026-10-09", accountId: explicitAccount ? "b" : "a", withTripAvailableMinor: explicitAccount ? "30000" : "80000" });
  const result = await evaluateIsolated(FALLBACK_CALCULATORS.trip_planner.source, { snapshot: built.snapshot, params });
  expect(result).toMatchObject({ numbers: { minimumHeadroomMinor: explicitAccount ? "30000" : "80000" } });
  const response = await POST(new Request("http://localhost/api/artifacts/trip", { method: "POST", body: JSON.stringify({ artifactId: "00000000-0000-4000-8000-000000000001", params }) }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(built.snapshot);
});

it("retains a complete multiple-account dated budget in the artifact instead of requiring a single selected account", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  fixture.input = { startDate: "2026-10-01", horizonDays: 29, currencyCode: "EUR", accounts: [{ id: "a", currencyCode: "EUR", balanceMinor: 10000n }, { id: "b", currencyCode: "EUR", balanceMinor: 10000n }], events: [{ accountId: "a", date: "2026-10-03", expectedMinor: 100000n }] };
  const base = defaultTripScenario(fixture.input.startDate, "EUR", "a", 20000n);
  const scenario = { ...base, payments: [...base.payments, { ...base.payments[0], accountId: "b", amountMinor: "20000" }] };
  const built = await buildCalculatorSnapshot("synthetic", "trip_planner", { costMinor: 40000n, tripScenario: scenario });
  expect(built.snapshot.unavailable).toBeNull();
  const result = await evaluateIsolated(FALLBACK_CALCULATORS.trip_planner.source, { snapshot: built.snapshot, params: { costMinor: 40000 } });
  expect(result).toMatchObject({ numbers: { minimumHeadroomMinor: "-10000", limitingDate: "2026-10-08" } });
});

it.each(["minimum before trip", "minimum after trip", "salary after trip", "negative funds", "hold", "available balance includes hold", "reservation", "missing balance"])("artifact, native metric and shared engine agree: %s", async kind => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  const input: ForecastInput = { startDate: "2026-10-01", horizonDays: 29, currencyCode: "EUR",
    accounts: [{ id: "a", currencyCode: "EUR", balanceMinor: kind === "negative funds" ? -50000n : kind === "missing balance" ? null : 10000n,
      ...(kind === "hold" || kind === "available balance includes hold" ? { pendingHoldMinor: 5000n } : {}),
      ...(kind === "available balance includes hold" ? { availableMinor: 5000n } : {}),
      ...(kind === "reservation" ? { reservedMinor: 15000n } : {}) }],
    events: [{ accountId: "a", date: kind === "salary after trip" ? "2026-10-10" : "2026-10-03", expectedMinor: 100000n },
      ...(kind === "minimum after trip" ? [{ accountId: "a", date: "2026-10-20", expectedMinor: -120000n }] : [])] };
  const scenario = defaultTripScenario(input.startDate, "EUR", "a", 20000n);
  fixture.input = input; fixture.scenario = scenario; fixture.manifest = FALLBACK_CALCULATORS.trip_planner.manifest;
  const native = evaluateTripScenario(input, scenario);
  const built = await buildCalculatorSnapshot("00000000-0000-4000-8000-000000000001", "trip_planner", { costMinor: 20000n, tripScenario: scenario });
  const result = await evaluateIsolated(FALLBACK_CALCULATORS.trip_planner.source, { snapshot: built.snapshot, params: { costMinor: 20000 } });
  const engine = accountLiquidity({ ...input, scenarioEvents: [{ accountId: "a", date: scenario.startsOn, expectedMinor: -20000n }] });
  if (engine.status === "available") {
    expect(native.withTripAvailableMinor).toBe(engine.accounts[0].spendableMinor.toString());
    expect(result).toMatchObject({ numbers: { minimumHeadroomMinor: native.withTripAvailableMinor, limitingDate: native.limitingDate, horizonFrom: "2026-10-01", horizonTo: "2026-10-29", afterTripMinor: native.afterTripMinor } });
    expect((result as { summary: string }).summary).toContain("minimum");
  } else expect(result).toMatchObject({ unavailable: expect.stringContaining("Forecast unavailable") });
  // The same host bridge recalculates edited local inputs without persisting or invoking AI.
  const response = await POST(new Request("http://localhost/api/artifacts/trip", { method: "POST", body: JSON.stringify({ artifactId: "00000000-0000-4000-8000-000000000001", params: { costMinor: 30000 }, baseScenario: scenario }) }));
  expect(response.status).toBe(200);
  const refreshed = await response.json();
  const edited = evaluateTripScenario(input, { ...scenario, payments: [{ ...scenario.payments[0], amountMinor: "30000" }] });
  expect(refreshed.withTripAvailableMinor).toBe(edited.withTripAvailableMinor);
  expect(input.scenarioEvents).toBeUndefined();
});

it.each(["trip_planner", "custom_planner"] as const)("actual manifest/snapshot rejects a USD scalar instead of forecasting EUR: %s", async kind => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  fixture.input = { startDate: "2026-10-01", horizonDays: 30, currencyCode: "EUR", accounts: [{ id: "a", currencyCode: "EUR", balanceMinor: 100000n }], events: [] };
  const manifest = calculatorManifestSchema.parse({ kind, runtime: "quickjs-calculator-v1", sdk: ["forecast"], params: { costMinor: { type: "number", default: 20000, currency: "USD" } } });
  const params = normalizeCalculatorParams(manifest);
  const native = evaluateTripScenario(fixture.input, defaultTripScenario("2026-10-01", "USD", "a", 20000n));
  expect(native.unavailable).toContain("rate:USD->EUR"); expect(native.withTripAvailableMinor).toBeNull();
  const built = buildCalculatorSnapshot("synthetic", kind, { costMinor: 20000n, tripParams: params, sdk: manifest.sdk, manifest });
  if (kind === "trip_planner") await expect(built).rejects.toThrow("Trip cost currency USD differs from forecast currency EUR");
  else expect((await built).snapshot).toMatchObject({ unavailable: expect.stringContaining("Trip cost currency USD differs from forecast currency EUR") });
});

it.each([false, true])("native original-currency preview retains explicit FX assumptions despite a USD scalar manifest: %s", async withFx => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  fixture.input = { startDate: "2026-10-01", horizonDays: 30, currencyCode: "EUR", accounts: [{ id: "a", currencyCode: "EUR", balanceMinor: 100000n }], events: [] };
  const scenario = defaultTripScenario("2026-10-01", "USD", "a", 20000n);
  if (withFx) scenario.payments[0].fx = { rate: "0.9", date: "2026-10-01", source: "Explicit user trip assumption" };
  fixture.scenario = scenario;
  fixture.manifest = { ...FALLBACK_CALCULATORS.trip_planner.manifest, params: { costMinor: { type: "number", default: 20000, currency: "USD" } } };
  const request = (body: unknown) => new Request("http://localhost/api/artifacts/trip", { method: "POST", body: JSON.stringify(body) });
  const response = await POST(request({ artifactId: "00000000-0000-4000-8000-000000000001", scenario }));
  expect(response.status).toBe(200); const snapshot = await response.json();
  expect(snapshot.tripResult.scenario).toEqual(scenario);
  if (withFx) expect(snapshot).toMatchObject({ withTripAvailableMinor: "82000", evaluatedCostMinor: "18000", unavailable: null });
  else expect(snapshot).toMatchObject({ withTripAvailableMinor: null, unavailable: expect.stringContaining("rate:USD->EUR") });
  const generated = await POST(request({ artifactId: "00000000-0000-4000-8000-000000000001", params: { costMinor: 20000 }, baseScenario: scenario }));
  expect(generated.status).toBe(400);
  expect(await generated.json()).toMatchObject({ error: expect.stringContaining("Trip cost currency USD differs from forecast currency EUR") });
});
it("explicit workspace-currency manifest retains normal scalar snapshot evidence", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  fixture.input = { startDate: "2026-10-01", horizonDays: 30, currencyCode: "EUR", accounts: [{ id: "a", currencyCode: "EUR", balanceMinor: 100000n }], events: [] };
  const manifest = calculatorManifestSchema.parse({ kind: "trip_planner", runtime: "quickjs-calculator-v1", sdk: ["forecast"], params: { costMinor: { type: "number", default: 20000, currency: "EUR" } } });
  expect((await buildCalculatorSnapshot("synthetic", "trip_planner", { manifest, costMinor: 20000n, tripParams: normalizeCalculatorParams(manifest) })).snapshot).toMatchObject({ withTripAvailableMinor: "80000", evaluatedCostMinor: "20000", unavailable: null });
});

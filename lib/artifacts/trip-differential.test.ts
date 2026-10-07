import { afterEach, expect, it, vi } from "vitest";
import { buildCalculatorSnapshot } from "./snapshot";
import { FALLBACK_CALCULATORS } from "./templates";
import { evaluateIsolated } from "./isolate";
import { accountLiquidity, type ForecastInput } from "@/lib/finance/calculations";
import { defaultTripScenario, evaluateTripScenario } from "@/lib/finance/trip-scenario";
import { POST } from "@/app/api/artifacts/trip/route";
const fixture = vi.hoisted(() => ({ input: {} as ForecastInput, scenario: {} as unknown, manifest: {} as unknown }));
vi.mock("@/lib/finance/model", () => ({ evaluatePlan: async (days: number) => ({ input: { ...fixture.input, horizonDays: days } }) }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { id: "w", display_currency: "EUR", timezone: "Europe/Berlin" }, supabase: { from: (table: string) => {
  const query = { select: () => query, eq: () => query, single: async () => ({ data: { permissions: ["forecast"], active_version_id: "v" }, error: null }),
    maybeSingle: async () => ({ data: table === "artifacts" ? { kind: "trip_planner", active_version_id: "v" } : table === "artifact_state" ? { state: { tripScenario: fixture.scenario } } : { manifest: fixture.manifest }, error: null }) }; return query;
} } }) }));
afterEach(() => vi.useRealTimers());

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

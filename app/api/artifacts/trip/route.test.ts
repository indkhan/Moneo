import { beforeEach, expect, it, vi } from "vitest";
import { POST } from "./route";
import { buildCalculatorSnapshot } from "@/lib/artifacts/snapshot";
import { defaultTripScenario } from "@/lib/finance/trip-scenario";
const fixture = vi.hoisted(() => ({ kind: "trip_planner", state: {} as Record<string, unknown>, sdk: ["forecast"] }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { id: "w", display_currency: "EUR", timezone: "Europe/Berlin" }, supabase: { from: (table: string) => {
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: table === "artifacts" ? { kind: fixture.kind, active_version_id: "v" } : table === "artifact_state" ? { state: fixture.state } : { manifest: { kind: fixture.kind, runtime: "quickjs-calculator-v1", sdk: fixture.sdk, params: { costMinor: { type: "number", default: 100, min: 0, max: 100000 } } } }, error: null }) }; return query;
} } }) }));
vi.mock("@/lib/artifacts/snapshot", () => ({ buildCalculatorSnapshot: vi.fn() }));
const id = "00000000-0000-4000-8000-000000000001";
function request(body: unknown) { return new Request("http://localhost/api/artifacts/trip", { method: "POST", body: JSON.stringify(body) }); }
beforeEach(() => { fixture.kind = "trip_planner"; fixture.sdk = ["forecast"]; fixture.state = { tripScenario: defaultTripScenario("2026-10-01", "EUR", "a", 20000n) }; vi.mocked(buildCalculatorSnapshot).mockReset().mockResolvedValue({ snapshot: { currency: "EUR", withTripAvailableMinor: "10000" }, stateParams: {} }); });
it("recomputes local cost inputs through owned host evidence without saving or an LLM", async () => {
  expect((await POST(request({ artifactId: id, params: { costMinor: 30000 } }))).status).toBe(200);
  expect(buildCalculatorSnapshot).toHaveBeenCalledWith(id, "trip_planner", expect.objectContaining({ tripParams: { costMinor: 30000 }, tripScenario: fixture.state.tripScenario }));
});
it("rejects malformed, undeclared or unpermitted requests before financial evaluation", async () => {
  expect((await POST(request({ artifactId: id, params: { invented: 1 } }))).status).toBe(400);
  fixture.sdk = [];
  expect((await POST(request({ artifactId: id, params: { costMinor: 100 } }))).status).toBe(400);
  fixture.kind = "goal_tracker";
  expect((await POST(request({ artifactId: id, scenario: fixture.state.tripScenario }))).status).toBe(400);
  expect(buildCalculatorSnapshot).not.toHaveBeenCalled();
});

import { beforeEach, expect, it, vi } from "vitest";
import { saveCalculatorParams, saveTripState } from "./actions";

const fixture = vi.hoisted(() => ({ version: 2, update: vi.fn(), filters: [] as [string, unknown][] }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { id: "owned" }, supabase: { from: (table: string) => {
  const query = { select: () => query, eq: (key: string, value: unknown) => { fixture.filters.push([key, value]); return query; },
    single: async () => ({ data: table === "artifacts" ? { kind: "trip_planner", active_version_id: "active" } : table === "artifact_versions" ? { manifest: { kind: "trip_planner", runtime: "quickjs-calculator-v1", sdk: [], params: { costMinor: { type: "number", default: 100, min: 0, max: 100000 } } } } : { state: { costMinor: 200 }, version: fixture.version }, error: null }),
    update: (value: unknown) => { fixture.update(value); return query; }, maybeSingle: async () => ({ data: { version: fixture.version + 1 }, error: null }) };
  return query;
} } }) }));
beforeEach(() => { fixture.version = 2; fixture.update.mockClear(); fixture.filters = []; });
function form(version: string) { const form = new FormData(); Object.entries({ artifactId: "00000000-0000-4000-8000-000000000001", params: '{"costMinor":300}', costMinor: "300", expectedVersion: version }).forEach(([key,value]) => form.set(key,value)); return form; }
it.each([saveCalculatorParams, saveTripState])("rejects a draft based on revision A after revision B was saved", async save => {
  expect(await save(form("1"))).toEqual({ conflict: true });
  expect(fixture.update).not.toHaveBeenCalled();
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

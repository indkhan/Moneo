import { beforeEach, expect, it, vi } from "vitest";
import ArtifactPage from "./page";
import { requireWorkspace } from "@/lib/auth";
import { buildCalculatorSnapshot } from "@/lib/artifacts/snapshot";
import { CalculatorPanel } from "../calculator-panel";
import type { ReactElement } from "react";

vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("@/lib/artifacts/snapshot", () => ({ buildCalculatorSnapshot: vi.fn() }));
vi.mock("@/lib/artifacts/finance-sdk", () => ({ spendingForArtifact: vi.fn(), tripForArtifact: vi.fn(), goalsForArtifact: vi.fn() }));
vi.mock("../calculator-panel", () => ({ CalculatorPanel: () => null }));
vi.mock("../version-editor", () => ({ VersionEditor: () => null }));
vi.mock("../generate-calculator-form", () => ({ GenerateCalculatorForm: () => null }));

beforeEach(() => { vi.mocked(buildCalculatorSnapshot).mockResolvedValue({ snapshot: { currency: "EUR" }, stateParams: {} }); });
async function restored(kind: "custom_report" | "trip_planner", state: Record<string, unknown>) {
  const key = kind === "trip_planner" ? "costMinor" : "amount";
  const manifest = { kind, runtime: "quickjs-calculator-v1", sdk: [], params: { [key]: { type: "number", default: 50, min: 0, max: 100 } } };
  const from = (table: string) => {
    const data = table === "artifacts" ? { kind, name: "Synthetic", active_version_id: "version" } : table === "artifact_state" ? { state } : table === "artifact_versions" ? { version: 1, source: "input => ({summary:'ok'})", manifest } : null;
    const query = { select: () => query, eq: () => query, order: () => query, single: async () => ({ data }), maybeSingle: async () => ({ data }), limit: async () => ({ data: [] }) };
    return query;
  };
  vi.mocked(requireWorkspace).mockResolvedValue({ supabase: { from }, workspace: { id: "workspace", display_currency: "EUR" } } as unknown as Awaited<ReturnType<typeof requireWorkspace>>);
  const page = await ArtifactPage({ params: Promise.resolve({ id: "synthetic" }), searchParams: Promise.resolve({}) });
  return (page.props.children as ReactElement[]).find(child => child?.type === CalculatorPanel)!.props as { initialParams: Record<string, unknown>; inputWarnings: string[] };
}
it("page applies the fallback it announces for incompatible saved bounds", async () => {
  const panel = await restored("custom_report", { amount: 500 });
  expect(panel.initialParams).toEqual({ amount: 50 });
  expect(panel.inputWarnings.join(";")).toContain("default applies");
});
it("page keeps generated trip defaults when no legacy cost exists", async () => {
  expect((await restored("trip_planner", {})).initialParams).toEqual({ costMinor: 50 });
});
it("snapshot failure retains compatible saved inputs", async () => {
  vi.mocked(buildCalculatorSnapshot).mockRejectedValue(new Error("Synthetic denied evidence"));
  expect((await restored("trip_planner", { costMinor: 75 })).initialParams).toEqual({ costMinor: 75 });
});

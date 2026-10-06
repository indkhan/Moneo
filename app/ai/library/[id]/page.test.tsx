import { beforeEach, expect, it, vi } from "vitest";
import ArtifactPage from "./page";
import { requireWorkspace } from "@/lib/auth";
import { buildCalculatorSnapshot } from "@/lib/artifacts/snapshot";
import { CalculatorPanel } from "../calculator-panel";
import { renameArtifact } from "../actions";
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
  return page;
}
async function panel(kind: "custom_report" | "trip_planner", state: Record<string, unknown>) {
  const page = await restored(kind, state);
  return (page.props.children as ReactElement[]).find(child => child?.type === CalculatorPanel)!.props as { initialParams: Record<string, unknown>; inputWarnings: string[] };
}
it("page applies the fallback it announces for incompatible saved bounds", async () => {
  const result = await panel("custom_report", { amount: 500 });
  expect(result.initialParams).toEqual({ amount: 50 });
  expect(result.inputWarnings.join(";")).toContain("default applies");
});
it("page keeps generated trip defaults when no legacy cost exists", async () => {
  expect((await panel("trip_planner", {})).initialParams).toEqual({ costMinor: 50 });
});
it("snapshot failure retains compatible saved inputs", async () => {
  vi.mocked(buildCalculatorSnapshot).mockRejectedValue(new Error("Synthetic denied evidence"));
  expect((await panel("trip_planner", { costMinor: 75 })).initialParams).toEqual({ costMinor: 75 });
});
it("never reuses an uncontrolled rename value with a refreshed expected revision", async () => {
  const page = await restored("custom_report", {});
  const element = (page.props.children as ReactElement<{ action?: unknown; activeVersionId?: string }>[]).find(child => child?.props?.action === renameArtifact)!;
  const form = typeof element.type === "function" ? (element.type as (props: unknown) => ReactElement)(element.props) : element;
  expect(form.key).toBe("version");
});

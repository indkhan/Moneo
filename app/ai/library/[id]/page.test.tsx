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

import React, { cloneElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tripForArtifact, goalsForArtifact } from "@/lib/artifacts/finance-sdk";
import { accountLiquidity, serializeAccountLiquidity } from "@/lib/finance/calculations";
vi.mock("next/link", () => ({ default: "a" }));
async function resolveNative(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(React.Children.toArray(node).map(resolveNative));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (typeof element.type === "function") return resolveNative(await (element.type as (props: unknown) => ReactNode)(element.props));
  const children = await resolveNative(element.props.children);
  return cloneElement(element, {}, ...(Array.isArray(children) ? React.Children.toArray(children) : [children]));
}
async function native(kind: "trip_planner" | "goal_tracker") {
  const from = (table: string) => {
    const data = table === "artifacts" ? { kind, name: "Synthetic builtin", active_version_id: "version" } : table === "artifact_state" ? { state: { costMinor: 10000 } } : table === "artifact_versions" ? { version: 1, source: "input => ({ready:true})", manifest: { kind, runtime: "trusted" } } : null;
    const query = { select: () => query, eq: () => query, order: () => query, single: async () => ({ data }), maybeSingle: async () => ({ data }), limit: async () => ({ data: [] }) }; return query;
  };
  vi.mocked(requireWorkspace).mockResolvedValue({ supabase: { from }, workspace: { id: "workspace", display_currency: "EUR" } } as unknown as Awaited<ReturnType<typeof requireWorkspace>>);
  return renderToStaticMarkup(await resolveNative(await ArtifactPage({ params: Promise.resolve({ id: "synthetic" }), searchParams: Promise.resolve({}) })));
}
it("trusted builtin trip renders chosen-account and dated scenario evidence without a calculator", async () => {
  const input = { startDate: "2026-10-07", horizonDays: 30, currencyCode: "EUR", accounts: [{ id: "checking", currencyCode: "EUR", balanceMinor: 10000n }, { id: "savings", currencyCode: "EUR", balanceMinor: 100000n }], events: [{ date: "2026-10-08", accountId: "checking", expectedMinor: -50000n, name: "Tomorrow bill" }] };
  const liquidity = accountLiquidity(input), tripLiquidity = accountLiquidity({ ...input, scenarioEvents: [{ date: "2026-10-14", accountId: "checking", expectedMinor: -10000n, name: "Trip" }] });
  if (liquidity.status !== "available" || tripLiquidity.status !== "available") throw new Error("Expected available");
  vi.mocked(tripForArtifact).mockResolvedValue({ currency: "EUR", tripDate: "2026-10-14", accountId: "checking", liquidity: serializeAccountLiquidity(liquidity), tripLiquidity: serializeAccountLiquidity(tripLiquidity), baseline: { status: "available", ...liquidity.accounts[0] }, withTrip: { status: "available", ...tripLiquidity.accounts[0] }, unavailable: null });
  const html = await native("trip_planner");
  expect(html).toContain("Chosen-account headroom"); expect(html).toContain("Aggregate headroom: EUR 600.00");
  expect(html).toContain("checking funding shortfall: EUR 400.00"); expect(html).toContain("2026-10-08"); expect(html).toContain("Tomorrow bill");
  expect(html).toContain("Dated trip evidence"); expect(html).toContain("checking funding shortfall: EUR 500.00"); expect(html).toContain("2026-10-14");
  expect(html).toContain("No automatic funding"); expect(html).not.toContain("Available to spend now"); expect(html).not.toContain("Generated calculator");
});
it("trusted goal illustration does not establish paying-account affordability", async () => {
  vi.mocked(goalsForArtifact).mockResolvedValue({ currency: "EUR", timezone: "UTC", balances: [], allocations: [], goals: [] });
  const html = await native("goal_tracker");
  expect(html).toContain("Illustrative saving pace is not an affordability result"); expect(html).toContain("dated account headroom and protections");
});

import { buildSourceCoverage } from "@/lib/finance/source-coverage";
import { beforeEach, expect, it, vi } from "vitest";
import ArtifactPage from "./page";
import { requireWorkspace } from "@/lib/auth";
import { buildCalculatorSnapshot } from "@/lib/artifacts/snapshot";
import { CalculatorPanel } from "../calculator-panel";
import { renameArtifact } from "../actions";
import type { ReactElement } from "react";

vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("@/lib/artifacts/snapshot", () => ({ buildCalculatorSnapshot: vi.fn() }));
vi.mock("@/lib/artifacts/finance-sdk", () => ({ spendingForArtifact: vi.fn(), tripForArtifact: vi.fn(), tripEditorForArtifact: vi.fn(), goalsForArtifact: vi.fn() }));
vi.mock("../calculator-panel", () => ({ CalculatorPanel: () => null }));
vi.mock("../version-editor", () => ({ VersionEditor: () => null }));
vi.mock("../generate-calculator-form", () => ({ GenerateCalculatorForm: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), notFound: vi.fn() }));

beforeEach(() => { vi.mocked(buildCalculatorSnapshot).mockResolvedValue({ snapshot: { currency: "EUR" }, stateParams: {} }); });
async function restored(kind: "custom_report" | "trip_planner", state: Record<string, unknown>, params?: Record<string, unknown>) {
  const key = kind === "trip_planner" ? "costMinor" : "amount";
  const manifest = { kind, runtime: "quickjs-calculator-v1", sdk: params ? ["forecast"] : [], params: params ?? { [key]: { type: "number", default: 50, min: 0, max: 100 } } };
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
it("restores stale scalar date/account inputs from the saved native simple budget", async () => {
  const scenario = defaultTripScenario("2026-10-02", "EUR", "b", 75n);
  const page = await restored("trip_planner", { costMinor: 50, tripDate: "2026-10-08", accountId: "a", tripScenario: scenario }, {
    costMinor: { type: "number", default: 50, min: 0, max: 100 }, tripDate: { type: "string", default: "2026-10-08" }, accountId: { type: "string", default: "a" },
  });
  const props = (page.props.children as ReactElement<{ initialParams: Record<string, unknown> }>[]).find(child => child?.type === CalculatorPanel)!.props;
  expect(props.initialParams).toEqual({ costMinor: 75, tripDate: "2026-10-09", accountId: "b" });
  expect(buildCalculatorSnapshot).toHaveBeenLastCalledWith("synthetic", "trip_planner", expect.objectContaining({ tripScenario: scenario, tripParams: props.initialParams }));
});
it("passes declared date/account defaults to first-load evidence without a saved scenario", async () => {
  const page = await restored("trip_planner", {}, { costMinor: { type: "number", default: 75 }, tripDate: { type: "string", default: "2026-10-09" }, accountId: { type: "string", default: "b" } });
  const props = (page.props.children as ReactElement<{ initialParams: Record<string, unknown> }>[]).find(child => child?.type === CalculatorPanel)!.props;
  expect(buildCalculatorSnapshot).toHaveBeenLastCalledWith("synthetic", "trip_planner", expect.objectContaining({ tripScenario: undefined, tripParams: props.initialParams }));
});
it("never reuses an uncontrolled rename value with a refreshed expected revision", async () => {
  const page = await restored("custom_report", {});
  const element = (page.props.children as ReactElement<{ action?: unknown; activeVersionId?: string }>[]).find(child => child?.props?.action === renameArtifact)!;
  const form = typeof element.type === "function" ? (element.type as (props: unknown) => ReactElement)(element.props) : element;
  expect(form.key).toBe("version");
});
it("does not replace an authoritative over-bound native cost with a cheaper generated default", async () => {
  const scenario = defaultTripScenario("2026-10-02", "EUR", "b", 20000000n);
  const page = await restored("trip_planner", { tripScenario: scenario }, {
    costMinor: { type: "number", default: 90000, min: 0, max: 10000000 },
  });
  const props = (page.props.children as ReactElement<{ initialParams: Record<string, unknown>; snapshot: unknown; inputWarnings: string[] }>[]).find(child => child?.type === CalculatorPanel)!.props;
  expect(props.initialParams).toEqual({ costMinor: 20000000 });
  expect(props.snapshot).toMatchObject({ unavailable: expect.stringContaining("cannot represent the saved dated scenario") });
  expect(props.inputWarnings.join(";")).not.toContain("default applies");
});

import React, { cloneElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TripStateForm } from "../trip-state-form";
import { DatedTripForm } from "../dated-trip-form";
import { defaultTripScenario, evaluateTripScenario } from "@/lib/finance/trip-scenario";
import { tripForArtifact, tripEditorForArtifact, goalsForArtifact } from "@/lib/artifacts/finance-sdk";
import { accountLiquidity } from "@/lib/finance/calculations";
vi.mock("next/link", () => ({ default: "a" }));
async function resolveNative(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(React.Children.toArray(node).map(resolveNative));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (element.type === TripStateForm || element.type === DatedTripForm) return element;
  if (typeof element.type === "function") return resolveNative(await (element.type as (props: unknown) => ReactNode)(element.props));
  const children = await resolveNative(element.props.children);
  return cloneElement(element, {}, ...(Array.isArray(children) ? React.Children.toArray(children) : [children]));
}
async function native(kind: "trip_planner" | "goal_tracker", scenario?: unknown) {
  const from = (table: string) => {
    const data = table === "artifacts" ? { kind, name: "Synthetic builtin", active_version_id: "version" } : table === "artifact_state" ? { state: { costMinor: 10000, ...(scenario ? { tripScenario: scenario } : {}) } } : table === "artifact_versions" ? { version: 1, source: "input => ({ready:true})", manifest: { kind, runtime: "trusted" } } : null;
    const query = { select: () => query, eq: () => query, order: () => query, single: async () => ({ data }), maybeSingle: async () => ({ data }), limit: async () => ({ data: [] }) }; return query;
  };
  vi.mocked(requireWorkspace).mockResolvedValue({ supabase: { from }, workspace: { id: "workspace", display_currency: "EUR" } } as unknown as Awaited<ReturnType<typeof requireWorkspace>>);
  return renderToStaticMarkup(await resolveNative(await ArtifactPage({ params: Promise.resolve({ id: "synthetic" }), searchParams: Promise.resolve({}) })));
}
it("trusted builtin trip renders chosen-account and dated scenario evidence without a calculator", async () => {
  const input = { startDate: "2026-10-07", horizonDays: 30, currencyCode: "EUR", accounts: [{ id: "checking", currencyCode: "EUR", balanceMinor: 10000n }, { id: "savings", currencyCode: "EUR", balanceMinor: 100000n }], events: [{ date: "2026-10-08", accountId: "checking", expectedMinor: -50000n, name: "Tomorrow bill" }] };
  const liquidity = accountLiquidity(input), tripLiquidity = accountLiquidity({ ...input, scenarioEvents: [{ date: "2026-10-14", accountId: "checking", expectedMinor: -10000n, name: "Trip" }] });
  if (liquidity.status !== "available" || tripLiquidity.status !== "available") throw new Error("Expected available");
  const result = evaluateTripScenario(input, defaultTripScenario(input.startDate, "EUR", "checking", 10000n));
  vi.mocked(tripForArtifact).mockResolvedValue({ ...result, tripResult: result, accounts: input.accounts.map(account => ({ id: account.id, currencyCode: account.currencyCode })), sourceCoverage: buildSourceCoverage({ from: "2026-10-01", to: "2026-10-02" }, []), resultBasis: "synthetic accepted evidence", tripDate: "2026-10-14", baseline: { status: "available", amountMinor: liquidity.accounts[0].spendableMinor, limitingDate: liquidity.accounts[0].spendingLimitingDate }, withTrip: null } as unknown as Awaited<ReturnType<typeof tripForArtifact>>);
  const html = await native("trip_planner");
  expect(html).toContain("Chosen-account headroom"); expect(html).toContain("Aggregate headroom: EUR 600.00");
  expect(html).toContain("checking funding shortfall: EUR 400.00"); expect(html).toContain("2026-10-08"); expect(html).toContain("Tomorrow bill");
  expect(html).toContain("Dated trip evidence"); expect(html).toContain("checking funding shortfall: EUR 500.00"); expect(html).toContain("2026-10-14");
  expect(html).toContain("No automatic funding"); expect(html).not.toContain("Available to spend now"); expect(html).not.toContain("Generated calculator");
});
it("trusted goal illustration does not establish paying-account affordability", async () => {
  vi.mocked(goalsForArtifact).mockResolvedValue({ sourceCoverage: buildSourceCoverage({ from: "2026-10-01", to: "2026-10-02" }, []), resultBasis: "synthetic accepted evidence", currency: "EUR", timezone: "UTC", balances: [], allocations: [], goals: [] });
  const html = await native("goal_tracker");
  expect(html).toContain("Illustrative saving pace is not an affordability result"); expect(html).toContain("dated account headroom and protections");
});

it("expired complex saved trips retain date/payment editor and the actual limitation", async () => {
  const scenario = defaultTripScenario("2026-09-01", "EUR", "checking", 10000n);
  scenario.payments.push({ ...scenario.payments[0], kind: "contribution", amountMinor: "2000" });
  const error = "Trip or payment date is in the past; choose future hypothetical dates";
  vi.mocked(tripForArtifact).mockRejectedValue(new Error(error));
  vi.mocked(tripEditorForArtifact).mockResolvedValue({ scenario, currency: "EUR", accounts: [{ id: "checking", currencyCode: "EUR", name: "Checking" }], error });
  const html = await native("trip_planner", scenario);
  expect(html).toContain('aria-label="Dated trip scenario"');
  expect(html).toContain('value="2026-09-08"');
  expect(html).toContain("Payment 2");
  expect(html).toContain("External contribution");
  expect(html).toContain(error);
  expect(html).toContain("Save scenario");
  expect(html).not.toContain("Check this tool&#x27;s permissions");
  expect(html).not.toContain('aria-label="Dated trip results"');
});
it("expired saved trip does not reveal the editor when current permission is denied", async () => {
  const scenario = defaultTripScenario("2026-09-01", "EUR", "checking", 10000n);
  vi.mocked(tripForArtifact).mockRejectedValue(new Error("Artifact permission denied"));
  vi.mocked(tripEditorForArtifact).mockRejectedValue(new Error("Artifact permission denied"));
  const html = await native("trip_planner", scenario);
  expect(html).not.toContain('aria-label="Dated trip scenario"');
  expect(html).toContain("Forecast evidence is unavailable");
});

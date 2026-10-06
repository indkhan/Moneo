import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Home from "./page";
vi.mock("./insights/panel", () => ({ ImportantInsights: () => null }));
const fixture = vi.hoisted(() => ({ started: [] as string[], errorTable: "", balanceGate: null as Promise<void> | null }));
beforeEach(() => { fixture.started = []; fixture.errorTable = ""; fixture.balanceGate = null; });

vi.mock("@/lib/env", () => ({ hasSupabase: () => true, getSupabaseConfig: () => ({ status: "configured", detail: "Supabase configuration is present." }) }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => {
  return { supabase: { from: (table: string) => {
    const result = () => { fixture.started.push(table); return { data: table === "dashboard_items" && fixture.errorTable === "artifacts" ? [{ artifact_id: "tool" }] : [], count: 0, error: fixture.errorTable === table ? new Error(`${table} unavailable`) : null }; };
    const query = { select: () => query, eq: () => query, in: () => query, is: () => query, range: async () => result(), order: () => query, limit: () => query, maybeSingle: async () => ({ ...result(), data: null }), then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve) };
    return query;
  } }, workspace: { id: "workspace", display_currency: "EUR", timezone: "Europe/Berlin" } };
} }));
vi.mock("@/lib/finance/balances", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/finance/balances")>(), loadBalanceEvidence: async () => { await fixture.balanceGate; return { accounts: [{ id: "cash", name: "Empty cash", currency_code: "EUR" }], snapshots: [], ledger: [], asOf: "2026-10-01T12:00:00Z" }; } }));
vi.mock("@/lib/finance/model", () => ({ evaluatePlanForWorkspace: async () => ({ available: { status: "unavailable", missingInputs: ["balance:cash"] }, liquidity: { status: "unavailable", missingInputs: ["balance:cash"] } }) }));
vi.mock("@/lib/finance/tools", () => ({ cashflow: async () => ({ unavailable: "No transactions" }) }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

it("shows a missing balance without inventing an epoch date or provenance", async () => {
  const html = renderToStaticMarkup(await Home());
  expect(html).toContain("Balance unknown");
  expect(html).toContain("Add a dated balance");
  expect(html).not.toContain("1970");
  expect(html).not.toContain("null · as of");
});

it("starts independent dashboard queries while balance evidence is still loading", async () => {
  let release!: () => void;
  fixture.balanceGate = new Promise(resolve => { release = resolve; });
  const page = Home();
  await new Promise(resolve => setTimeout(resolve, 0));
  const started = [...fixture.started];
  release();
  await page;
  expect(started).toEqual(expect.arrayContaining(["fx_rates", "dashboard_items", "dashboard_layouts", "goals", "goal_allocations"]));
});

it.each(["fx_rates", "dashboard_items", "artifacts"])("reports %s failures instead of silently showing incomplete dashboard data", async table => {
  fixture.errorTable = table;
  await expect(Home()).rejects.toThrow(`${table} unavailable`);
});

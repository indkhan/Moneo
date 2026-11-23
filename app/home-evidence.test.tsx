import { buildSourceCoverage } from "@/lib/finance/source-coverage";
import { beforeEach, expect, it, vi } from "vitest";
import { renderToReadableStream } from "react-dom/server";
import Home from "./page";
vi.mock("./agent-briefing", () => ({ AgentBriefing: () => null, loadAgentBriefing: async () => null }));
vi.mock("./insights/panel", () => ({ WeeklyBriefing: () => null, loadInsightEvidence: async () => ({}) }));
const fixture = vi.hoisted(() => ({ started: [] as string[], errorTable: "", balanceGate: null as Promise<void> | null }));
beforeEach(() => { fixture.started = []; fixture.errorTable = ""; fixture.balanceGate = null; });

vi.mock("@/lib/env", () => ({ hasSupabase: () => true, getSupabaseConfig: () => ({ status: "configured", detail: "Supabase configuration is present." }) }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => {
  return { supabase: { from: (table: string) => {
    const result = () => { fixture.started.push(table); return { data: [], count: 0, error: fixture.errorTable === table ? new Error(`${table} unavailable`) : null }; };
    const query = { select: () => query, eq: () => query, in: () => query, is: () => query, not: () => query, range: async () => result(), order: () => query, limit: () => query, maybeSingle: async () => ({ ...result(), data: null }), then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve) };
    return query;
  } }, workspace: { id: "workspace", display_currency: "EUR", timezone: "Europe/Berlin" } };
} }));
vi.mock("@/lib/finance/balances", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/finance/balances")>(), loadBalanceEvidence: async () => { await fixture.balanceGate; return { accounts: [{ id: "cash", name: "Empty cash", currency_code: "EUR" }], snapshots: [], ledger: [], asOf: "2026-10-01T12:00:00Z" }; } }));
vi.mock("@/lib/finance/model", () => ({ evaluatePlanForWorkspace: async () => ({ sourceCoverage: buildSourceCoverage({ from: "2026-10-01", to: "2026-10-07" }, []), available: { status: "unavailable", missingInputs: ["balance:cash"] }, liquidity: { status: "unavailable", missingInputs: ["balance:cash"] } }) }));
vi.mock("@/lib/finance/tools", async original => ({ ...await original<typeof import("@/lib/finance/tools")>(), cashflow: async () => ({ sourceCoverage: buildSourceCoverage({ from: "2026-10-01", to: "2026-10-07" }, []), unavailable: "No transactions" }) }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

it("shows a missing balance without inventing an epoch date or provenance", async () => {
  const stream = await renderToReadableStream(await Home());
  await stream.allReady;
  const html = await new Response(stream).text();
  expect(html).toContain("Balance unknown");
  expect(html).toContain("Add a dated balance");
  expect(html).toContain("<summary class=\"cursor-pointer text-xs font-medium text-brand hover:underline\">Update balance</summary>");
  for (const text of ["Net worth", "Coming up"]) expect(html).toContain(text);
  expect(html).not.toContain("1970");
  expect(html).not.toContain("null · as of");
});

it("streams the Home heading and starts independent queries while balance evidence is still loading", async () => {
  let release!: () => void;
  fixture.balanceGate = new Promise(resolve => { release = resolve; });
  const stream = await renderToReadableStream(await Home());
  const reader = stream.getReader();
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("Overview");
    await vi.waitFor(() => expect(fixture.started).toEqual(expect.arrayContaining(["fx_rates", "dashboard_layouts", "bank_connection_accounts"])));
  } finally {
    release();
    await stream.allReady;
    reader.releaseLock();
  }
});

it.each(["fx_rates", "dashboard_layouts"])("reports %s failures instead of silently showing incomplete dashboard data", async table => {
  fixture.errorTable = table;
  const onError = vi.fn();
  const stream = await renderToReadableStream(await Home(), { onError });
  await stream.allReady;
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: `${table} unavailable` }), expect.anything());
});

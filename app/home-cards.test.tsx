import { buildSourceCoverage } from "@/lib/finance/source-coverage";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import Home from "./page";

const live = "11111111-1111-4111-8111-111111111111", deleted = "22222222-2222-4222-8222-222222222222";
vi.mock("@/lib/env", () => ({ getSupabaseConfig: () => ({ status: "configured" }) }));
vi.mock("@/lib/finance/model", () => ({ evaluatePlanForWorkspace: async () => ({ sourceCoverage: buildSourceCoverage({ from: "2026-10-01", to: "2026-10-07" }, []), input: null, available: null, liquidity: null }) }));
vi.mock("./insights/panel", () => ({ WeeklyBriefing: () => null, loadInsightEvidence: async () => ({}) }));
vi.mock("./agent-briefing", () => ({ AgentBriefing: () => null, loadAgentBriefing: async () => null }));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("@/lib/finance/dashboard-spending", () => ({ loadHomeSpending: async () => ({}) }));
vi.mock("@/lib/finance/wealth", () => ({ loadWealthItems: async () => [], wealthEvidence: () => ({ included: [], missingInputs: [], outdated: [], sourceCoverage: buildSourceCoverage({ from: "2026-10-01", to: "2026-10-07", recordBasis: "manual_wealth" }, []) }) }));
vi.mock("@/lib/finance/balances", async original => ({ ...await original<typeof import("@/lib/finance/balances")>(), loadBalanceEvidence: async () => ({ accounts: [], snapshots: [], ledger: [], asOf: "2026-10-07T12:00:00Z" }) }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { id: "synthetic", timezone: "UTC", display_currency: "EUR", locale: "en" }, settings: {}, supabase: { from: (table: string) => {
  // Only the live card comes back from the cards read, as if the other one was deleted.
  const rows = table === "artifact_cards" ? [{ id: "11111111-1111-4111-8111-111111111111", artifact_id: "33333333-3333-4333-8333-333333333333", title: "Rent what-if", size: "S", published_version: 1 }] : [];
  const q = { select: () => q, eq: () => q, in: () => q, is: () => q, not: () => q, order: () => q, limit: () => q, range: async () => ({ data: [], count: 0, error: null }),
    maybeSingle: async () => ({ data: table === "dashboard_layouts" ? { items: ["card:11111111-1111-4111-8111-111111111111", "card:22222222-2222-4222-8222-222222222222", "goals"], version: 3 } : null, error: null }),
    then: (resolve: (data: unknown) => unknown) => resolve({ data: rows, count: 0, error: null }) };
  return q;
} } }) }));

it("shows artifact cards on Home in layout order, at their size, and drops deleted ones", async () => {
  const html = renderToStaticMarkup(await Home({ searchParams: Promise.resolve({}) }));
  expect(html).toContain('aria-label="Rent what-if"');
  expect(html).toMatch(new RegExp(`lg:col-span-2[^"]*"[^>]*>(?:(?!</div>).)*aria-label="Rent what-if"`));
  expect(html).not.toContain(`artifact:${live}`);
  expect(html).not.toContain(deleted);
  expect(html.indexOf("Rent what-if")).toBeLessThan(html.indexOf(">Goals<"));
});

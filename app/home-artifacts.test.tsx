import { buildSourceCoverage } from "@/lib/finance/source-coverage";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import Home from "./page";

const live = "11111111-1111-4111-8111-111111111111", deleted = "22222222-2222-4222-8222-222222222222";
vi.mock("@/lib/env", () => ({ getSupabaseConfig: () => ({ status: "configured" }) }));
vi.mock("@/lib/finance/model", () => ({ evaluatePlanForWorkspace: async () => ({ sourceCoverage: buildSourceCoverage({ from: "2026-10-01", to: "2026-10-07" }, []), input: null, available: null, liquidity: null }) }));
vi.mock("./insights/panel", () => ({ WeeklyBriefing: () => null, loadInsightEvidence: async () => ({}) }));
vi.mock("./agent-briefing", () => ({ AgentBriefing: () => null }));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("@/lib/finance/dashboard-spending", () => ({ loadHomeSpending: async () => ({}) }));
vi.mock("@/lib/finance/wealth", () => ({ loadWealthItems: async () => [], wealthEvidence: () => ({ included: [], missingInputs: [], sourceCoverage: buildSourceCoverage({ from: "2026-10-01", to: "2026-10-07", recordBasis: "manual_wealth" }, []) }) }));
vi.mock("@/lib/finance/balances", async original => ({ ...await original<typeof import("@/lib/finance/balances")>(), loadBalanceEvidence: async () => ({ accounts: [], snapshots: [], ledger: [], asOf: "2026-10-07T12:00:00Z" }) }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { id: "synthetic", timezone: "UTC", display_currency: "EUR", locale: "en" }, settings: {}, supabase: { from: (table: string) => {
  // Only the live artifact comes back from the artifacts read, as if the other one was deleted.
  const rows = table === "artifacts" ? [{ id: "11111111-1111-4111-8111-111111111111", title: "Rent what-if" }] : [];
  const q = { select: () => q, eq: () => q, in: () => q, is: () => q, order: () => q, limit: () => q, range: async () => ({ data: [], count: 0, error: null }),
    maybeSingle: async () => ({ data: table === "dashboard_layouts" ? { items: ["artifact:11111111-1111-4111-8111-111111111111", "artifact:22222222-2222-4222-8222-222222222222", "goals"], version: 3 } : null, error: null }),
    then: (resolve: (data: unknown) => unknown) => resolve({ data: rows, count: 0, error: null }) };
  return q;
} } }) }));

it("shows pinned artifacts as Home cards in layout order and drops deleted ones", async () => {
  const html = renderToStaticMarkup(await Home({ searchParams: Promise.resolve({}) }));
  expect(html).toContain('aria-label="Rent what-if"');
  expect(html).toContain(`href="/ai/artifacts/${live}"`);
  expect(html).not.toContain(deleted);
  expect(html.indexOf("Rent what-if")).toBeLessThan(html.indexOf(">Goals<"));
});

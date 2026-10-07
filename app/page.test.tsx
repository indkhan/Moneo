import { buildSourceCoverage } from "@/lib/finance/source-coverage";
import React, { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import Home from "./page";
import { accountLiquidity, availableToSpend, forecastDaily, type ForecastInput } from "@/lib/finance/calculations";
import { evaluatePlanForWorkspace } from "@/lib/finance/model";
vi.mock("@/lib/env", () => ({ getSupabaseConfig: () => ({ status: "configured" }) }));
vi.mock("@/lib/finance/model", () => ({ evaluatePlanForWorkspace: vi.fn() }));
vi.mock("./insights/panel", () => ({ ImportantInsights: () => null }));
vi.mock("./manual-balance-form", () => ({ ManualBalanceForm: () => null }));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("@/lib/finance/tools", () => ({ cashflow: async () => ({ sourceCoverage: buildSourceCoverage({ from: "2026-10-01", to: "2026-10-07" }, []), unavailable: "Synthetic period" }) }));
vi.mock("@/lib/finance/wealth", () => ({ loadWealthItems: async () => [], wealthEvidence: () => ({ included: [], missingInputs: [], sourceCoverage: buildSourceCoverage({ from: "2026-10-01", to: "2026-10-07", recordBasis: "manual_wealth" }, []) }) }));
vi.mock("@/lib/finance/balances", async original => ({ ...await original<typeof import("@/lib/finance/balances")>(), loadBalanceEvidence: async () => ({ accounts: [{ id: "checking", name: "Checking", currency_code: "EUR" }, { id: "savings", name: "Savings", currency_code: "EUR" }], snapshots: [], ledger: [], asOf: "2026-10-07T12:00:00Z" }) }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { id: "synthetic", timezone: "UTC", display_currency: "EUR", locale: "en" }, settings: {}, supabase: { from: () => {
  const q = { select: () => q, eq: () => q, order: () => q, range: async () => ({ data: [], error: null }), limit: () => q, maybeSingle: async () => ({ data: { items: ["planning", "upcoming"] }, error: null }), then: (resolve: (data: unknown) => unknown) => resolve({ data: [], count: 0, error: null }) }; return q;
} } }) }));
const input: ForecastInput = { startDate: "2026-10-07", horizonDays: 30, currencyCode: "EUR", accounts: [
  { id: "checking", balanceMinor: 10000n, currencyCode: "EUR" }, { id: "savings", balanceMinor: 100000n, currencyCode: "EUR" }], events: [{ date: "2026-10-08", accountId: "checking", expectedMinor: -50000n, name: "Recurring bill", source: "confirmed" }] };
beforeEach(() => vi.mocked(evaluatePlanForWorkspace).mockResolvedValue({ sourceCoverage: buildSourceCoverage({ from: "2026-10-01", to: "2026-10-07" }, []), input, forecast: forecastDaily(input), available: availableToSpend(input), liquidity: accountLiquidity(input) } as Awaited<ReturnType<typeof evaluatePlanForWorkspace>>));
async function resolveTree(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(React.Children.toArray(node).map(resolveTree));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (typeof element.type === "function") return resolveTree(await (element.type as (props: unknown) => ReactNode)(element.props));
  const children = await resolveTree(element.props.children);
  return cloneElement(element, {}, ...(Array.isArray(children) ? React.Children.toArray(children) : [children]));
}
const render = async (account?: string) => renderToStaticMarkup(await resolveTree(await Home({ searchParams: Promise.resolve({ account }) })));
it("Home labels pooled EUR600 separately and surfaces checking EUR400 deficit/date/bill", async () => {
  const html = await render("checking");
  expect(html).toContain("Aggregate headroom"); expect(html).toContain("EUR 600.00");
  expect(html).toContain("Checking funding shortfall: EUR 400.00"); expect(html).toContain("2026-10-08");
  expect(html).toContain("Recurring bill"); expect(html).toContain("Chosen-account headroom");
  expect(html).toContain("-EUR 400.00"); expect(html).not.toContain("Available to spend</h2>");
  expect(html).toContain("/plan?account=checking");
});
it("Home requires a chosen account and never silently selects savings to hide checking", async () => {
  expect(await render()).toContain("Choose a paying account");
  expect(await render("missing")).toContain("Choose a current liquid account");
  expect(await render("savings")).toContain("Checking funding shortfall: EUR 400.00");
});
it("Home retains per-account reservations and donor limitation", async () => {
  const protectedInput = { ...input, accounts: [{ ...input.accounts[0], reservedMinor: 1000n }, { ...input.accounts[1], reservedMinor: 90000n }] };
  vi.mocked(evaluatePlanForWorkspace).mockResolvedValue({ sourceCoverage: buildSourceCoverage({ from: "2026-10-01", to: "2026-10-07" }, []), input: protectedInput, forecast: forecastDaily(protectedInput), available: availableToSpend(protectedInput), liquidity: accountLiquidity(protectedInput) } as Awaited<ReturnType<typeof evaluatePlanForWorkspace>>);
  const html = await render("savings");
  expect(html).toContain("Checking funding shortfall: EUR 410.00"); expect(html).toContain("Protected funds: EUR 900.00");
  expect(html).toContain("-EUR 310.00"); expect(html).toContain("No automatic transfer");
});
it("Home preserves unavailable evidence rather than displaying pooled spending", async () => {
  const unknown = { ...input, missingInputs: ["balance:checking:unreviewed"] };
  vi.mocked(evaluatePlanForWorkspace).mockResolvedValue({ sourceCoverage: buildSourceCoverage({ from: "2026-10-01", to: "2026-10-07" }, []), input: unknown, forecast: forecastDaily(unknown), available: availableToSpend(unknown), liquidity: accountLiquidity(unknown) } as Awaited<ReturnType<typeof evaluatePlanForWorkspace>>);
  const html = await render("checking"); expect(html).toContain("unreviewed"); expect(html).not.toContain("EUR 600.00");
});

it("chosen-account spending respects a separately owned workspace buffer", async () => {
  input.workspaceBufferMinor = 10000n;
  try {
    // Re-evaluate mocked loader after changing the input.
    vi.mocked(evaluatePlanForWorkspace).mockResolvedValue({ sourceCoverage: buildSourceCoverage({ from: "2026-10-01", to: "2026-10-07" }, []), input, forecast: forecastDaily(input), available: availableToSpend(input), liquidity: accountLiquidity(input), preferences: { spending_account_id: null }, preferencesVersion: 0 } as Awaited<ReturnType<typeof evaluatePlanForWorkspace>>);
    const html = await render("savings");
    expect(html).toContain("Workspace buffer: EUR 100.00");
    expect(html).toContain("EUR 500.00");
    expect(html).toContain("Checking funding shortfall: EUR 400.00");
    expect(html).toContain("limited by both account liquidity and aggregate headroom");
  } finally { input.workspaceBufferMinor = 0n; }
});

import { buildSourceCoverage } from "@/lib/finance/source-coverage";
import React, { isValidElement, cloneElement, type ReactNode, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import PlanPage from "./page";
import { evaluatePlan } from "@/lib/finance/model";
import { accountLiquidity, availableToSpend, forecastDaily, type ForecastInput } from "@/lib/finance/calculations";
import { evaluateForecast } from "@/lib/finance/tools";

vi.mock("@/lib/finance/model", () => ({ evaluatePlan: vi.fn() }));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("./history", () => ({ PlanningHistory: () => null }));
vi.mock("./goal-plan", () => ({ GoalPlanEditor: () => null, GoalPlanHistory: () => null }));
vi.mock("./preferences", () => ({ ForecastPreferenceEditor: () => null }));
vi.mock("./scenarios", () => ({ ScenarioEditor: () => null, ScenarioHistory: () => null }));
vi.mock("./model-sources", () => ({ ModelSources: () => null }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => {
  const accounts = [{ id: "checking", name: "Checking", currency_code: "EUR" }, { id: "savings", name: "Savings", currency_code: "EUR" }];
  return { workspace: { id: "synthetic", display_currency: "EUR", timezone: "Europe/Berlin", locale: "en" },
    supabase: { from: (table: string) => {
      const q = { select: () => q, eq: () => q, is: () => q, order: () => q, limit: () => q,
        then: (resolve: (result: unknown) => unknown) => resolve({ data: table === "accounts" ? accounts : table === "scenarios" ? [{ id: "00000000-0000-4000-8000-000000000001", name: "Test scenario" }] : [], error: null }) };
      return q;
    } },
  };
} }));
const input: ForecastInput = { startDate: "2026-10-07", horizonDays: 3, currencyCode: "EUR",
  accounts: [{ id: "checking", currencyCode: "EUR", balanceMinor: 10000n }, { id: "savings", currencyCode: "EUR", balanceMinor: 100000n }],
  events: [{ date: "2026-10-08", accountId: "checking", expectedMinor: -50000n, name: "Tomorrow bill", source: "confirmed" }],
};
beforeEach(() => {
  vi.mocked(evaluatePlan).mockImplementation(async () => ({ sourceCoverage: buildSourceCoverage({ from: "2026-10-01", to: "2026-10-07" }, []), input, forecast: forecastDaily(input), available: availableToSpend(input), liquidity: accountLiquidity(input), preferences: { spending_account_id: null }, preferencesVersion: 0 }) as Awaited<ReturnType<typeof evaluatePlan>>);
});
async function resolveTree(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(React.Children.toArray(node).map(resolveTree));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (typeof element.type === "function") return resolveTree(await (element.type as (props: unknown) => ReactNode)(element.props));
  const children = await resolveTree(element.props.children);
  return cloneElement(element, {}, ...(Array.isArray(children) ? React.Children.toArray(children) : [children]));
}
async function render(params: Record<string, string> = {}) {
  return renderToStaticMarkup(await resolveTree(await PlanPage({ searchParams: Promise.resolve(params) })));
}
it("renders checking's dated EUR 400 shortfall and bill even while aggregate cash is EUR 600", async () => {
  const html = await render({ account: "checking", horizon: "3" });
  expect(html).toContain("Checking funding shortfall: EUR 400.00");
  expect(html).toContain("Aggregate headroom"); expect(html).toContain("EUR 600.00");
  expect(html).toContain("Chosen-account headroom"); expect(html).toContain("-EUR 400.00");
  expect(html).toContain("2026-10-08"); expect(html).toContain("Tomorrow bill");
  expect(html).toContain("No automatic transfer"); expect(html).not.toContain("One planned month fits");
  expect(await evaluateForecast({ accountId: "checking", horizonDays: 3 })).toMatchObject({
    availableToSpendMinor: "-40000", aggregateAvailableMinor: "60000", limitingDate: "2026-10-08",
  });
});
it.each([["2026-10-08", false], ["2026-10-09", true]])("renders only timely explicit paired funding as resolved: %s", async (date, shortfall) => {
  const html = await render({ account: "checking", horizon: "3", fundingFrom: "savings", fundingDate: date, fundingMinor: "40000" });
  expect(html.includes("Checking funding shortfall: EUR 400.00")).toBe(shortfall);
  expect(html).toContain("EUR 600.00"); expect(html).toContain(`value="${date}"`);
  expect(html).toContain('value="40000"'); expect(html).toContain("Hypothetical funding");
  const scenarioLink = [...html.matchAll(/href="([^"]*)"/g)].map(match => match[1].replaceAll("&amp;", "&")).find(href => href.includes("scenario=00000000"))!;
  const query = new URL(scenarioLink, "https://synthetic.test").searchParams;
  expect(query.get("account")).toBe("checking"); expect(query.get("horizon")).toBe("3");
  expect(query.get("fundingDate")).toBe(date); expect(query.get("fundingMinor")).toBe("40000");
  expect(input.events).toHaveLength(1);
});
it("does not turn incomplete balance evidence into an available forecast", async () => {
  const unknown = { ...input, missingInputs: ["balance:checking:boundary evidence unavailable"] };
  vi.mocked(evaluatePlan).mockResolvedValue({ sourceCoverage: buildSourceCoverage({ from: "2026-10-01", to: "2026-10-07" }, []), input: unknown, forecast: forecastDaily(unknown), available: availableToSpend(unknown), liquidity: accountLiquidity(unknown), preferences: {}, preferencesVersion: 0 } as Awaited<ReturnType<typeof evaluatePlan>>);
  const html = await render({ account: "checking" });
  expect(html).toContain("Forecast unavailable"); expect(html).toContain("boundary evidence unavailable");
  expect(html).not.toContain("Aggregate headroom"); expect(html).not.toContain("Chosen-account headroom");
});
it("does not select pooled spending or discard unknown account and invalid funding input", async () => {
  expect(await render()).toContain("Choose a paying account");
  const html = await render({ account: "missing", fundingFrom: "savings", fundingDate: "2026-10-09", fundingMinor: "bad" });
  expect(html).toContain("Choose a current liquid account"); expect(html).toContain('value="bad"');
  expect(html).toContain("Funding was not applied");
});
it("renders account-specific protections and keeps horizon/scenario/account/funding controls", async () => {
  const protectedInput = { ...input, accounts: [{ ...input.accounts[0], minimumMinor: 2000n }, { ...input.accounts[1], reservedMinor: 30000n }] };
  vi.mocked(evaluatePlan).mockResolvedValue({ sourceCoverage: buildSourceCoverage({ from: "2026-10-01", to: "2026-10-07" }, []), input: protectedInput, forecast: forecastDaily(protectedInput), available: availableToSpend(protectedInput), liquidity: accountLiquidity(protectedInput), preferences: {}, preferencesVersion: 0 } as Awaited<ReturnType<typeof evaluatePlan>>);
  const html = await render({ account: "checking", horizon: "3", scenario: "00000000-0000-4000-8000-000000000001" });
  expect(html).toContain("Checking funding shortfall: EUR 420.00");
  expect(html).toContain("Minimum balance: EUR 20.00"); expect(html).toContain("Goal reservations: EUR 300.00");
  expect(html).toContain('name="scenario"'); expect(html).toContain('name="account"'); expect(html).toContain('value="3"');
});

it("chosen-account spending respects a separately owned workspace buffer", async () => {
  input.workspaceBufferMinor = 10000n;
  try {
    // Re-evaluate mocked loader after changing the input.
    vi.mocked(evaluatePlan).mockResolvedValue({ sourceCoverage: buildSourceCoverage({ from: "2026-10-01", to: "2026-10-07" }, []), input, forecast: forecastDaily(input), available: availableToSpend(input), liquidity: accountLiquidity(input), preferences: { spending_account_id: null }, preferencesVersion: 0 } as Awaited<ReturnType<typeof evaluatePlan>>);
    const html = await render({ account: "savings", horizon: "3" });
    expect(html).toContain("Workspace buffer: EUR 100.00");
    expect(html).toContain("EUR 500.00");
    expect(html).toContain("Checking funding shortfall: EUR 400.00");
    expect(html).toContain("limited by both account liquidity and aggregate headroom");
  } finally { input.workspaceBufferMinor = 0n; }
});

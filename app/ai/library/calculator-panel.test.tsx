import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { calculatorManifestSchema } from "@/lib/artifacts/spec";
import { CalculatorPanel } from "./calculator-panel";

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./actions", () => ({ saveCalculatorParams: vi.fn() }));
vi.mock("@/lib/artifacts/run", () => ({ runIsolatedArtifact: vi.fn() }));

it("discloses host input coverage independently of generated output", () => {
  const html = renderToStaticMarkup(<CalculatorPanel source="input => ({summary:'ok'})" snapshot={{currency: "EUR", coverage: {balances: {total: 51, included: 50, truncated: true}, goals: {total: 20, included: 20, truncated: false}}}} initialParams={{}} manifest={calculatorManifestSchema.parse({kind:"custom_report",runtime:"quickjs-calculator-v1",sdk:[],params:{}})} versionLabel="v1" artifactId="synthetic" />);
  expect(html).toContain("50 of 51 balances");
  expect(html).toContain("Remaining records are excluded");
  expect(html).not.toContain("20 of 20 goals");
});

it("shows the trusted host evidence failure even if generated code returns a generic message", () => {
  const reason = "cashflow: AI access to transactions is disabled in Settings";
  const html = renderToStaticMarkup(<CalculatorPanel source="input => ({ unavailable: 'No cashflow' })" snapshot={{ currency: "EUR", unavailable: reason }} initialParams={{}} manifest={calculatorManifestSchema.parse({kind:"custom_report",runtime:"quickjs-calculator-v1",sdk:[],params:{}})} versionLabel="v1" artifactId="test" />);
  expect(html).toContain(reason);
  expect(html).toContain('role="alert"');
});

import { accountLiquidity, serializeAccountLiquidity } from "@/lib/finance/calculations";
it("renders host account limits independently of calculator claims", () => {
  const liquidity = serializeAccountLiquidity(accountLiquidity({ startDate: "2026-10-07", horizonDays: 3, currencyCode: "EUR", workspaceBufferMinor: 10000n, accounts: [{ id: "checking", currencyCode: "EUR", balanceMinor: 10000n }, { id: "savings", currencyCode: "EUR", balanceMinor: 100000n }], events: [{ date: "2026-10-08", accountId: "checking", expectedMinor: -50000n, name: "Bill" }] }));
  const html = renderToStaticMarkup(<CalculatorPanel source="input => ({summary:'Affordable'})" snapshot={{ currency: "EUR", accountId: "checking", liquidity }} initialParams={{}} manifest={calculatorManifestSchema.parse({kind:"trip_planner",runtime:"quickjs-calculator-v1",sdk:["forecast"],params:{}})} versionLabel="v1" artifactId="synthetic" />);
  expect(html).toContain("Chosen-account headroom"); expect(html).toContain("-EUR 400.00");
  expect(html).toContain("Aggregate headroom: EUR 500.00"); expect(html).toContain("Workspace buffer: EUR 100.00");
  expect(html).toContain("checking funding shortfall: EUR 400.00"); expect(html).toContain("2026-10-08"); expect(html).toContain("Bill");
  expect(html).toContain("No automatic funding");
});

import { ForecastEvidence } from "./forecast-evidence";
import { withInternalFunding } from "@/lib/finance/calculations";
it.each(["2026-10-08", "2026-10-09"])("native evidence preserves funding timing %s", date => {
  const input = { startDate: "2026-10-07", horizonDays: 3, currencyCode: "EUR", accounts: [{ id: "checking", currencyCode: "EUR", balanceMinor: 10000n }, { id: "savings", currencyCode: "EUR", balanceMinor: 100000n }], events: [{ date: "2026-10-08", accountId: "checking", expectedMinor: -50000n }] };
  const liquidity = serializeAccountLiquidity(accountLiquidity(withInternalFunding(input, [{ date, currencyCode: "EUR", fromAccountId: "savings", toAccountId: "checking", amountMinor: 40000n }])));
  const html = renderToStaticMarkup(<ForecastEvidence evidence={{ accountId: "checking", liquidity }} />);
  expect(html).toContain("Aggregate headroom: EUR 600.00");
  if (date === "2026-10-08") { expect(html).not.toContain("funding shortfall:"); expect(html).toContain("Internal funding in"); }
  else expect(html).toContain("checking funding shortfall: EUR 400.00");
});
it.each([false, true])("native evidence respects workspace buffer independent of order %s", reverse => {
  const accounts = [{ id: "empty", currencyCode: "EUR", balanceMinor: 0n }, { id: "funded", currencyCode: "EUR", balanceMinor: 100000n }];
  if (reverse) accounts.reverse();
  const liquidity = serializeAccountLiquidity(accountLiquidity({ startDate: "2026-10-07", horizonDays: 2, currencyCode: "EUR", workspaceBufferMinor: 10000n, accounts, events: [] }));
  const html = renderToStaticMarkup(<ForecastEvidence evidence={{ accountId: "funded", liquidity }} />);
  expect(html).toContain("funded: EUR 900.00"); expect(html).toContain("Account liquidity EUR 1000.00"); expect(html).not.toContain("funding shortfall:");
});

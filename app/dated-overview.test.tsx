import React, {cloneElement, isValidElement, type ReactElement, type ReactNode} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {afterEach, expect, it, vi} from "vitest";
import Home from "./page";

vi.mock("next/link", () => ({default: "a"}));
vi.mock("@/lib/env", () => ({getSupabaseConfig: () => ({status: "configured"})}));
vi.mock("./insights/panel", () => ({ImportantInsights: () => null}));
vi.mock("./manual-balance-form", () => ({ManualBalanceForm: () => null}));
vi.mock("@/lib/finance/model", () => ({evaluatePlanForWorkspace: async () => ({input: null, liquidity: null})}));
vi.mock("@/lib/finance/tools", () => ({cashflow: async () => ({unavailable: "Synthetic unavailable cash"})}));
vi.mock("@/lib/finance/wealth", async original => ({...await original<typeof import("@/lib/finance/wealth")>(), loadWealthItems: async () => [
  {id: "asset", name: "Recorded asset", amount_minor: "20000", currency_code: "EUR", as_of: "2026-09-30", linked_account_id: null},
  {id: "debt", name: "Recorded debt", amount_minor: "-10000", currency_code: "EUR", as_of: "2026-09-29", linked_account_id: null},
  {id: "yen", name: "Original yen", amount_minor: "300", currency_code: "JPY", as_of: "2026-09-28", linked_account_id: null},
]}));
vi.mock("@/lib/finance/balances", async original => ({...await original<typeof import("@/lib/finance/balances")>(), loadBalanceEvidence: async () => ({
  accounts: [{id: "bank", name: "Recorded bank", currency_code: "EUR"}, {id: "unknown", name: "Unknown cash", currency_code: "EUR"}],
  snapshots: [{id: "snapshot", account_id: "bank", amount_minor: "50000", currency_code: "EUR", as_of: "2026-09-30T12:00:00Z", provenance: "import:synthetic"}],
  ledger: [], asOf: "2026-10-08T12:00:00Z",
})}));
vi.mock("@/lib/auth", () => ({requireWorkspace: async () => ({workspace: {id: "synthetic", timezone: "UTC", display_currency: "EUR", locale: "en"}, settings: {}, supabase: {from: () => {
  const q = {select: () => q, eq: () => q, order: () => q, range: async () => ({data: [], error: null}), limit: () => q,
    maybeSingle: async () => ({data: {items: ["overview"]}, error: null}), then: (resolve: (data: unknown) => unknown) => resolve({data: [], count: 0, error: null})}; return q;
}}})}));

async function resolveTree(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(React.Children.toArray(node).map(resolveTree));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<{children?: ReactNode}>;
  if (typeof element.type === "function") return resolveTree(await (element.type as (props: unknown) => ReactNode)(element.props));
  const children = await resolveTree(element.props.children);
  return cloneElement(element, {}, ...(Array.isArray(children) ? React.Children.toArray(children) : [children]));
}
afterEach(() => vi.useRealTimers());
it("keeps useful dated net worth after day rollover without asserting current cash or inventing FX", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
  const html = renderToStaticMarkup(await resolveTree(await Home()));
  expect(html).toContain("Recorded net worth by currency");
  expect(html).toContain("EUR 600.00"); expect(html).toContain("JPY 300");
  for (const text of ["2026-09-30", "2026-09-29", "Recorded debt", "import:synthetic", "Unknown cash", "Different observation dates", "not verified current funds"]) expect(html).toContain(text);
  expect(html).toContain("Net worth unavailable in EUR");
});

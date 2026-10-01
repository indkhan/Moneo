import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Home from "./page";

vi.mock("@/lib/env", () => ({ hasSupabase: () => true }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => {
  const query = { select: () => query, eq: () => query, order: () => query, limit: () => query, maybeSingle: async () => ({ data: null, error: null }), then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], count: 0, error: null }).then(resolve) };
  return { supabase: { from: () => query }, workspace: { id: "workspace", display_currency: "EUR", timezone: "Europe/Berlin" } };
} }));
vi.mock("@/lib/finance/balances", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/finance/balances")>(), loadBalanceEvidence: async () => ({ accounts: [{ id: "cash", name: "Empty cash", currency_code: "EUR" }], snapshots: [], ledger: [], asOf: "2026-10-01T12:00:00Z" }) }));
vi.mock("@/lib/finance/model", () => ({ evaluatePlan: async () => ({ available: { status: "unavailable", missingInputs: ["balance:cash"] } }) }));
vi.mock("@/lib/finance/tools", () => ({ cashflow: async () => ({ unavailable: "No transactions" }) }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

it("shows a missing balance without inventing an epoch date or provenance", async () => {
  const html = renderToStaticMarkup(await Home());
  expect(html).toContain("Balance unknown");
  expect(html).toContain("Add a dated balance");
  expect(html).not.toContain("1970");
  expect(html).not.toContain("null · as of");
});

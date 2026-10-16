import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./actions", () => ({ editAccount: async () => ({}), updateBalance: async () => ({}), undoBalance: async () => {}, undoMoneyMetadata: async () => {}, addAccount: async () => {} }));
const query = (data: unknown[]) => { const q = { select: () => q, eq: () => q, order: () => q, limit: () => q, then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve) }; return q; };
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({
  workspace: { id: "w", locale: "en-US", timezone: "UTC", display_currency: "EUR" },
  supabase: { from: (table: string) => query(table === "money_metadata_events" ? [
    { id: "e1", entity_type: "account", entity_id: "imported", before: { name: "Old", version: 1 }, after: { name: "Checking", version: 2 }, created_at: "2026-10-01T00:00:00Z", undone_at: null, undo_of: null },
  ] : []) },
}) }));
vi.mock("@/lib/finance/balances", async original => ({ ...await original<typeof import("@/lib/finance/balances")>(), loadBalanceEvidence: async () => ({
  asOf: "2026-10-16T12:00:00Z",
  accounts: [
    { id: "imported", name: "account-statement_2025-11-05_en · Current", type: "checking", currency_code: "EUR", archived_at: null, version: 2 },
    { id: "empty", name: "Cash jar", type: "cash", currency_code: "EUR", archived_at: null, version: 1 },
    { id: "old", name: "Closed card", type: "credit", currency_code: "EUR", archived_at: "2026-01-01T00:00:00Z", version: 3 },
  ],
  snapshots: [
    { id: "s1", account_id: "imported", amount_minor: "10000", currency_code: "EUR", as_of: "2026-09-01T12:00:00Z", provenance: "import", created_at: "2026-09-01T12:00:00Z", version: 1 },
    { id: "s2", account_id: "imported", amount_minor: "12000", currency_code: "EUR", as_of: "2026-10-10T12:00:00Z", provenance: "manual", actor_id: "me", created_at: "2026-10-10T12:00:00Z", version: 1 },
  ],
  ledger: [{ id: "t1", account_id: "imported", amount_minor: "-500", currency_code: "EUR", posted_on: "2026-10-12", status: "posted", version: 1 }],
}) }));

it("lists balances with as-of date, trend, rename suggestion, balance update and undo", async () => {
  const { default: AccountsPage } = await import("./page");
  const html = renderToStaticMarkup(await AccountsPage());
  expect(html).toContain("EUR 115.00");
  expect(html).toContain("Estimated · as of 2026-10-10");
  expect(html).toContain("<polyline");
  expect(html).toContain("Rename to “Revolut Current”");
  expect(html).toContain("No balance yet");
  expect(html).toContain("Total across 2 active accounts (partial)");
  expect(html).toContain('name="expectedSnapshotId" value="s2"');
  expect(html).toContain("Undo balance");
  expect(html).toContain("Archived accounts (1)");
  expect(html).toContain("renamed “Old” → “Checking”");
  expect(html).toContain(">Undo</button>");
});

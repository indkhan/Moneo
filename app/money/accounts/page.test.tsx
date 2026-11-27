import { expect, it, vi } from "vitest";
import { text } from "node:stream/consumers";
import { prerenderToNodeStream } from "react-dom/static";

vi.mock("@/components/safe-form", () => ({ SafeForm: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/components/connected-banks", () => ({ ConnectedArea: ({ feeds, scalable }: { feeds: Record<string, React.ReactNode>; scalable: React.ReactNode }) =>
  <>{Object.entries(feeds).map(([id, feed]) => <section key={id} data-bank={id}>{feed}</section>)}{scalable}</> }));
vi.mock("@/components/scalable-connection", () => ({ ScalableCard: ({ children }: { children: React.ReactNode }) => <section data-scalable>{children}</section> }));
vi.mock("./actions", () => ({ setScalableArtifactDataSafely: async () => ({}),  editAccount: async () => ({}), updateBalance: async () => ({}), undoBalanceSafely: async () => ({}), undoMoneyMetadataSafely: async () => ({}), removeOwnAccountSafely: async () => ({}), findTransfersSafely: async () => ({}), addAccount: async () => {}, addAccountSafely: async () => ({}), addOwnAccountSafely: async () => ({}), addOwnAccount: async () => {}, removeOwnAccount: async () => {}, findTransfersBetweenOwnAccounts: async () => {} }));
const query = (data: unknown[] | unknown) => { const q = { select: () => q, eq: () => q, gte: () => q, is: () => q, range: () => q, in: () => q, not: () => q, order: () => q, limit: () => q, maybeSingle: () => q,
  then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve) }; return q; };
const portfolio = { asOf: "2026-11-06", currency: "EUR", totalMinor: "1234500", securitiesMinor: "1000000", cryptoMinor: "34500", cashMinor: "200000",
  performance: [{ timeframe: "ONE_MONTH", returnMinor: "-4200" }] };
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({
  workspace: { id: "w", locale: "en-US", timezone: "UTC", display_currency: "EUR" }, settings: { artifact_scalable_data: "snapshot" },
  supabase: { from: (table: string) => query(table === "money_metadata_events" ? [
    { id: "e1", entity_type: "account", entity_id: "imported", before: { name: "Old", version: 1 }, after: { name: "Checking", version: 2 }, created_at: "2026-10-01T00:00:00Z", undone_at: null, undo_of: null },
  ] : table === "bank_connection_accounts" ? [{ connection_id: "c1", account_name: "Cash jar", currency_code: "EUR", iban: "DE89370400440532013000", last_booked_on: "2026-10-15", bank_connections: { status: "active" } }]
    : table === "own_account_identifiers" ? [{ id: "i1", account_id: null, iban: "DE02120300000000202051", label: "Savings at DKB" }]
    : table === "scalable_connections" ? { portfolio } : []) },
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
const { default: AccountsPage } = await import("./page");

async function render(options?: Parameters<typeof AccountsPage>[0]) {
  const { prelude } = await prerenderToNodeStream(await AccountsPage(options));
  return (await text(prelude)).replaceAll("<!-- -->", "");
}

it("lists balances with as-of date, trend, rename suggestion, balance update and undo", async () => {
  const html = await render();
  expect(html).toContain("EUR 115.00");
  expect(html).toContain("2026-10-10");
  expect(html).toContain("<polyline");
  expect(html).toContain('name="name" value="Revolut Current"');
  expect(html).toContain("From 1 of 2 accounts");
  expect(html).toContain("on 2026-10-16, 3 recorded");
  expect(html).toContain('name="expectedSnapshotId" value="s2"');
  expect(html).toContain('name="snapshotId" value="s2"');
  expect(html).toContain("Archived accounts (1)");
  expect(html).toContain("renamed “Old” → “Checking”");
  expect(html).toContain('name="eventId" value="e1"');
  expect(html.match(/name="expectedSnapshotId"/g)).toHaveLength(1);
});

it("lists own account IBANs masked and reports found transfers", async () => {
  const html = await render({ searchParams: Promise.resolve({ transfers: "2-1-0" }) });
  expect(html).toContain("Savings at DKB · ••2051");
  expect(html).not.toContain("DE02120300000000202051");
  expect(html).toContain("Found 2 transfer pairs and 1 payment to your untracked accounts.");
});

it("lists a bank-fed account once, inside its bank's card, and tags the others with their source", async () => {
  const html = await render();
  const bank = html.slice(html.indexOf('data-bank="c1"'), html.indexOf("</section>", html.indexOf('data-bank="c1"')));
  expect(bank).toContain('aria-label="Cash jar"');
  expect(bank).toContain("••3000 · synced through 2026-10-15");
  expect(html.match(/aria-label="Cash jar"/g)).toHaveLength(1);
  expect(html.slice(html.indexOf('aria-label="account-statement'))).toContain("Entered by hand");
});

it("shows the synced Scalable portfolio inside the Scalable card", async () => {
  const html = await render();
  const card = html.slice(html.indexOf("data-scalable"));
  expect(card).toContain("12,345.00");
});

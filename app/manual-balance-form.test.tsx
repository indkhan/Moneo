import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ManualBalanceForm } from "./manual-balance-form";
vi.mock("./actions", () => ({ setManualBalance: async () => {}, undoManualBalance: async () => {}, confirmRecordedBalance: async () => {} }));
it("shows the exact review list, leaves confirmation unchecked and submits latest undo history version", () => {
  const account = { id: "synthetic", name: "Synthetic cash", currency_code: "EUR" };
  const row = { id: "morning", account_id: account.id, amount_minor: "-100", currency_code: "EUR", posted_on: "2026-10-06", posted_at: "2026-10-06T08:00:00Z", status: "posted", description: "Synthetic morning", version: 0 };
  const html = renderToStaticMarkup(<ManualBalanceForm account={account} snapshots={[{ id: "undone", account_id: account.id, amount_minor: "10000", currency_code: "EUR", as_of: "2026-10-06T12:00:00Z", provenance: "manual", created_at: "2026-10-06T12:00:00Z", version: 2, actor_id: "actor", undone_at: "2026-10-06T12:01:00Z" }]}
    ledger={[row, { ...row, id: "date-only", description: "Synthetic date only", posted_at: undefined }, { ...row, id: "pending", description: "Synthetic pending", status: "pending" }]}
    asOf="2026-10-06T14:00:00Z" timeZone="Europe/Berlin" locale="en-US" />);
  expect(html).toContain("Synthetic morning"); expect(html).toContain("Synthetic date only"); expect(html).not.toContain("Synthetic pending");
  expect(html).toContain("includes all 2 listed postings"); expect(html).toContain('name="expectedSnapshotId" value="undone"');
  expect(html).toContain('name="expectedVersion" value="2"'); expect(html).toContain('&quot;version&quot;:0');
  expect(html).not.toContain('checked=""');
});

it("lets users verify recorded activity without retyping an exact historical balance", () => {
  const account = {id: "cash", name: "Recorded cash", currency_code: "EUR"};
  const snapshot = {id: "old", account_id: account.id, amount_minor: "10000", currency_code: "EUR", as_of: "2026-09-30T12:00:00Z", provenance: "manual", version: 1};
  const prior = {id: "prior", account_id: account.id, amount_minor: "-100", currency_code: "EUR", posted_on: "2026-10-01", status: "posted", description: "Earlier recorded payment"};
  const today = {...prior, id: "today", amount_minor: "-250", posted_on: "2026-10-08", description: "Today recorded payment"};
  const props = {account, snapshots: [snapshot], ledger: [prior, today, {...today, id: "pending", status: "pending", description: "Not booked"}], asOf: "2026-10-08T12:00:00Z", timeZone: "UTC", locale: "en"};
  const html = renderToStaticMarkup(<ManualBalanceForm {...props} />);
  expect(html).toContain("Confirm recorded balance");
  expect(html).toContain('name="amount" value="96.50"');
  expect(html).toContain("Earlier recorded payment"); expect(html).toContain("Today recorded payment");
  expect(html).not.toContain("Not booked"); expect(html).not.toContain('checked=""');
  expect(html).toContain("I checked my bank"); expect(html).toContain("before pending holds");
  expect(html).toMatch(/<input(?=[^>]*name="reviewedActivity")(?=[^>]*required="")[^>]*>/);
  expect(html).toContain("Recorded changes since 2026-09-30");
  const uncertain = renderToStaticMarkup(<ManualBalanceForm {...props} snapshots={[{...snapshot, currency_code: "JPY"}]} />);
  expect(uncertain).not.toContain("Confirm recorded balance");
});

import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ManualBalanceForm } from "./manual-balance-form";
vi.mock("./actions", () => ({ setManualBalance: async () => {}, undoManualBalance: async () => {} }));
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

import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Page from "./page";
const fixture = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { id: "owned" } }) }));
vi.mock("@/lib/finance/evidence-view", () => ({ readEvidenceView: fixture.read }));
it("shows the exact selected calculation, actual supporting records, retained date and visible staleness", async () => {
  fixture.read.mockResolvedValue({ receipt: { id: "00000000-0000-4000-8000-000000000001", fetchedAt: "2026-10-01T00:00:00Z", calculationVersion: "cashflow-v1", query: { from: "2026-09-01", to: "2026-09-30" }, metrics: [] }, metric: { id: "spending", label: "Spending", valueMinor: "9007199254740993", currency: "EUR", period: { from: "2026-09-01", to: "2026-09-30" }, qualifiers: ["partial_coverage"], calculation: "Sum reviewed spending less refunds", sourceIds: ["actual"] }, supportingRecords: [{ id: "actual", type: "transaction", version: "v1", href: "/money/transactions?transaction=00000000-0000-4000-8000-000000000002", record: { amount_minor: "-9007199254740993", review_reasons: [] } }], freshness: { status: "stale", reason: "Source records changed" } });
  const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000001" }), searchParams: Promise.resolve({ metric: "spending" }) }));
  expect(html).toContain("EUR 90071992547409.93");
  expect(html).toContain("Source records changed");
  expect(html).toContain("2026-10-01");
  expect(html).toContain("Sum reviewed spending less refunds");
  expect(html).toContain("transaction=00000000-0000-4000-8000-000000000002");
  expect(html).toContain("partial_coverage");
});

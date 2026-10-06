import { afterEach, expect, it, vi } from "vitest";
import { POST } from "./route";

const fixture = vi.hoisted(() => ({ source: {} as Record<string, unknown>, mapping: {} as Record<string, unknown>, calls: [] as Record<string, unknown>[] }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { id: "workspace" }, supabase: {
  from: (table: string) => {
    const query = { select: () => query, eq: () => query,
      maybeSingle: async () => ({ data: fixture.source, error: null }),
      single: async () => ({ data: table === "imports" ? { mapping: fixture.mapping } : fixture.source, error: null }) };
    return query;
  },
  rpc: async (_name: string, args: Record<string, unknown>) => { fixture.calls.push(args); return { data: { status: "accepted" }, error: null }; },
} }) }));
afterEach(() => { fixture.calls = []; });

const mapping = { accountName: "Synthetic", currencyCode: "EUR", dateColumn: "Date", descriptionColumn: "Description", amountColumn: "Amount", dateFormat: "iso", amountSign: "signed", numericConvention: "decimal-dot" };
const request = () => new Request("http://localhost/api/imports/import/review", { method: "POST", body: JSON.stringify({ sourceId: "source", action: "accept" }) });

it("accepts the exact corrected overlap row despite decisions for other original indices", async () => {
  fixture.source = { id: "source", row_number: 3, status: "review", original_row: { Date: "bad", Description: "Original", Amount: "2", Currency: "USD", State: "unsupported" } };
  fixture.mapping = { ...mapping, currencyColumn: "Currency", statusColumn: "State", rowDecisions: [
    { rowNumber: 2, action: "correct", values: { Description: "Other observation" } },
    { rowNumber: 3, action: "correct", values: { Date: "2026-09-02", Description: "Reviewed", Currency: "EUR", State: "pending" } },
    { rowNumber: 4, action: "exclude", reason: "Footer" },
  ] };
  const response = await POST(request(), { params: Promise.resolve({ id: "import" }) });
  expect(response.status).toBe(200);
  expect(fixture.calls[0]).toMatchObject({ p_posted_on: "2026-09-02", p_description: "Reviewed", p_amount_minor: "200", p_currency_code: "EUR" });
  expect(fixture.source.original_row).toMatchObject({ Date: "bad", Description: "Original", Currency: "USD", State: "unsupported" });
});

it("never applies a saved row-two correction to an unrelated overlap observation", async () => {
  fixture.source = { id: "source", row_number: 4, status: "review", original_row: { Date: "2026-09-02", Description: "Actual row four", Amount: "2" } };
  fixture.mapping = { ...mapping, rowDecisions: [{ rowNumber: 2, action: "correct", values: { Description: "Wrong observation" } }] };
  const response = await POST(request(), { params: Promise.resolve({ id: "import" }) });
  expect(response.status).toBe(200);
  expect(fixture.calls[0].p_description).toBe("Actual row four");
});

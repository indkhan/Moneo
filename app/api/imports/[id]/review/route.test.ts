import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import Papa from "papaparse";
import { POST } from "./route";

function csv() {
  const count = Math.max(Number(fixture.source.row_number)-1, ...(fixture.mapping.rowDecisions as { rowNumber: number }[] ?? []).map(item => item.rowNumber-1));
  return Papa.unparse(Array.from({ length: count }, (_, index) => index+2 === fixture.source.row_number ? fixture.source.original_row as Record<string,string> : { ...(fixture.source.original_row as Record<string,string>), Date: "2026-09-02", ...(Object.hasOwn(fixture.source.original_row as object, "Currency") ? { Currency: "EUR" } : {}), ...(Object.hasOwn(fixture.source.original_row as object, "State") ? { State: "posted" } : {}) }));
}
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ storage: { from: () => ({ download: async () => ({ data: new Blob([csv()]), error: null }) }) },
  rpc: async (name: string, args: Record<string,unknown>) => { fixture.calls.push({ ...args, rpcName: name }); return { error: null }; } }) }));
const fixture = vi.hoisted(() => ({ source: {} as Record<string, unknown>, mapping: {} as Record<string, unknown>, calls: [] as Record<string, unknown>[] }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { id: "workspace" }, supabase: {
  from: (table: string) => {
    const query = { select: () => query, eq: () => query,
      maybeSingle: async () => ({ data: fixture.source, error: null }),
      single: async () => ({ data: table === "imports" ? { mapping: fixture.mapping, route_accounts: {}, storage_path: "workspace/synthetic.csv", file_hash: createHash("sha256").update(csv()).digest("hex") } : fixture.source, error: null }) };
    return query;
  },
  rpc: async (name: string, args: Record<string, unknown>) => { fixture.calls.push({ ...args, rpcName: name }); return { data: { status: "accepted" }, error: null }; },
} }) }));
afterEach(() => { fixture.calls = []; vi.unstubAllEnvs(); });
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-test-key");

const mapping = { accountName: "Synthetic", currencyCode: "EUR", dateColumn: "Date", descriptionColumn: "Description", amountColumn: "Amount", dateFormat: "iso", amountSign: "signed", numericConvention: "decimal-dot" };
const request = () => new Request("http://localhost/api/imports/import/review", { method: "POST", body: JSON.stringify({ sourceId: "source", action: "accept" }) });

it("accepts the exact corrected overlap row despite decisions for other original indices", async () => {
  fixture.source = { id: "source", row_number: 3, status: "review", original_row: { Date: "bad", Description: "Original", Amount: "2", Currency: "USD", State: "unsupported" } };
  fixture.mapping = { ...mapping, currencyColumn: "Currency", statusColumn: "State", rowDecisions: [
    { rowNumber: 2, action: "correct", values: { Description: "Other observation" } },
    { rowNumber: 3, action: "correct", values: { Date: "2026-09-02", Description: "Reviewed", Currency: "EUR", State: "pending" } },
    { rowNumber: 4, action: "exclude", reason: "Footer" },
  ] };
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-test-key");
  const response = await POST(request(), { params: Promise.resolve({ id: "import" }) });
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
  expect(fixture.calls[0].p_row).toMatchObject({ postedOn: "2026-09-02", description: "Reviewed", amountMinor: "200", currencyCode: "EUR", rowNumber: 3, status: "pending" });
  expect(fixture.calls[1]).toMatchObject({ p_source_id: "source", p_action: "accept" });
  expect(fixture.calls[1]).not.toHaveProperty("p_amount_minor");
  expect(fixture.source.original_row).toMatchObject({ Date: "bad", Description: "Original", Currency: "USD", State: "unsupported" });
});

it("never applies a saved row-two correction to an unrelated overlap observation", async () => {
  fixture.source = { id: "source", row_number: 4, status: "review", original_row: { Date: "2026-09-02", Description: "Actual row four", Amount: "2" } };
  fixture.mapping = { ...mapping, rowDecisions: [{ rowNumber: 2, action: "correct", values: { Description: "Wrong observation" } }] };
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-test-key");
  const response = await POST(request(), { params: Promise.resolve({ id: "import" }) });
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
  expect(fixture.calls[0].p_row).toMatchObject({ description: "Actual row four", rowNumber: 4 });
});

it("accepts persisted normalized evidence without reparsing or a value-taking RPC", async () => {
  fixture.source = { id: "source", row_number: 3, status: "review", original_row: { Date: "Original invalid date" }, normalized_row: { row: { postedAt: "2026-09-01T08:00:00Z" }, accountId: "frozen" } };
  fixture.mapping = {};
  const response = await POST(request(), { params: Promise.resolve({ id: "import" }) });
  expect(response.status).toBe(200);
  expect(fixture.calls).toEqual([{ rpcName: "resolve_normalized_import_review", p_source_id: "source", p_action: "accept", p_expected_route_id: null, p_account_id: null, p_expected_account_version: null }]);
});

it("passes only an explicitly reviewed destination snapshot", async () => {
  fixture.source = { id: "source", status: "review", normalized_row: {} };
  const accountId = "11111111-1111-4111-a111-111111111111";
  const expectedRouteId = "22222222-2222-4222-a222-222222222222";
  const response = await POST(new Request("http://localhost/review", { method: "POST", body: JSON.stringify({ sourceId: "source", action: "accept", accountId, expectedRouteId, expectedAccountVersion: 4 }) }), { params: Promise.resolve({ id: "import" }) });
  expect(response.status).toBe(200);
  expect(fixture.calls[0]).toMatchObject({ p_account_id: accountId, p_expected_route_id: expectedRouteId, p_expected_account_version: 4 });
});

it("accepts settlement only through the atomic normalized settlement RPC", async () => {
  fixture.source = { id: "source", status: "review", normalized_row: {} };
  const settlement = { pendingId: "11111111-1111-4111-a111-111111111111", pendingVersion: 0, expectedReleasedMinor: "0", releasedMinor: "2000", note: "Bank reference confirmed", requestId: "22222222-2222-4222-a222-222222222222" };
  const response = await POST(new Request("http://localhost/review", { method: "POST", body: JSON.stringify({ sourceId: "source", action: "accept", settlement }) }), { params: Promise.resolve({ id: "import" }) });
  expect(response.status).toBe(200);
  expect(fixture.calls).toEqual([{ rpcName: "settle_import_review", p_source_id: "source", p_pending_id: settlement.pendingId,
    p_pending_version: 0, p_expected_released_minor: "0", p_released_minor: "2000", p_note: settlement.note, p_request_id: settlement.requestId,
    p_expected_route_id: null, p_account_id: null, p_expected_account_version: null }]);
});

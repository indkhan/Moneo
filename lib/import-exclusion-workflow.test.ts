import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { importFile } from "@/workflows/import-file";

const fixture = vi.hoisted(() => ({ calls: [] as { name: string; args: Record<string, unknown> }[], status: "queued", version: 1, correction: false, exclusions: 1 }));
const csv = () => `Date,Description,Amount\n${Array.from({ length: fixture.exclusions }, () => ",Statement footer,1").join("\n")}`;
const correctionCsv = "Date,Description,Amount,State,Type,Fee\nbad,Refund,2,unsupported,Card refund,1";
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("@/workflows/financial-review", () => ({ financialReview: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({
  rpc: async (name: string, args: Record<string, unknown>) => { fixture.calls.push({ name, args }); return { data: name === "finish_import_run" ? "completed" : null, error: null }; },
  storage: { from: () => ({ download: async () => ({ data: new Blob([fixture.correction ? correctionCsv : csv()]), error: null }) }) },
  from: () => {
    const query = { select: () => query, eq: () => query,
      limit: async () => ({ data: [{ id: "synthetic-account" }], error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: (result: { data: never[]; error: null }) => unknown) => Promise.resolve(resolve({ data: [], error: null })),
      single: async () => ({ data: { status: fixture.status, run_version: fixture.version, storage_path: "workspace/synthetic.csv", file_hash: createHash("sha256").update(fixture.correction ? correctionCsv : csv()).digest("hex"),
        mapping: { accountName: "Synthetic", currencyCode: "EUR", dateColumn: "Date", descriptionColumn: "Description", amountColumn: "Amount", dateFormat: "iso", amountSign: "signed", numericConvention: "decimal-dot",
          ...(fixture.correction ? { statusColumn: "State", typeColumn: "Type", feeColumn: "Fee", rowDecisions: [{ rowNumber: 2, action: "correct", values: { Date: "2026-09-01T12:00:00Z", State: "pending" } }] } : { rowDecisions: Array.from({ length: fixture.exclusions }, (_, index) => ({ rowNumber: index + 2, action: "exclude", reason: "Statement footer" })) }) }, new_rows: 0, matched_rows: 0, review_rows: 0 }, error: null }),
    };
    return query;
  },
}) }));
afterEach(() => { fixture.calls = []; fixture.status = "queued"; fixture.version = 1; fixture.correction = false; fixture.exclusions = 1; vi.unstubAllEnvs(); });

it("processes each excluded original index exactly once across a workflow chunk boundary", async () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.invalid");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-key");
  vi.stubEnv("OPENROUTER_API_KEY", "");
  fixture.exclusions = 251;
  await importFile("import", "workspace", 251);
  const rows = fixture.calls.filter(call => call.name === "record_import_exclusion").map(call => (call.args.p_row as { rowNumber: number }).rowNumber);
  expect(rows).toEqual(Array.from({ length: 251 }, (_, index) => index + 2));
});

it("executes the complete reviewed corrected row while retaining original status and date evidence", async () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.invalid");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-key");
  vi.stubEnv("OPENROUTER_API_KEY", "");
  fixture.correction = true;
  await importFile("import", "workspace", 1);
  await importFile("import", "workspace", 1);
  const calls = fixture.calls.filter(call => call.name === "ingest_import_row");
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(calls[1]);
  expect(calls[0].args.p_row).toMatchObject({ rowNumber: 2, postedOn: "2026-09-01", postedAt: "2026-09-01T12:00:00.000Z", status: "pending", kind: "refund", amountMinor: "200", currencyCode: "EUR",
    reviewReasons: ["fee_semantics"], feeEvidence: { treatment: "unknown", feeMinor: "100" }, originalRow: { Date: "bad", Description: "Refund", Amount: "2", State: "unsupported", Type: "Card refund", Fee: "1" } });
  expect(fixture.calls.find(call => call.name === "prepare_import_route")?.args.p_total_rows).toBe(1);
});

it("persists excluded original observations with stable identities across retries", async () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.invalid");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-key");
  vi.stubEnv("OPENROUTER_API_KEY", "");
  await importFile("import", "workspace", 1);
  await importFile("import", "workspace", 1);
  const calls = fixture.calls.filter(call => call.name === "record_import_exclusion");
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(calls[1]);
  expect(calls[0].args.p_row).toMatchObject({ rowNumber: 2, originalRow: { Date: "", Description: "Statement footer", Amount: "1" }, reason: "Statement footer" });
  expect(fixture.calls.some(call => call.name === "ingest_import_row")).toBe(false);
});

it("does not persist exclusions after cancellation or run supersession", async () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.invalid");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-key");
  fixture.status = "canceled";
  await importFile("import", "workspace", 1);
  fixture.status = "running"; fixture.version = 2;
  await importFile("import", "workspace", 1, 1);
  expect(fixture.calls.filter(call => call.name === "record_import_exclusion")).toHaveLength(0);
});

import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { importFile } from "@/workflows/import-file";

const fixture = vi.hoisted(() => ({ calls: [] as { name: string; args: Record<string, unknown> }[], status: "queued", version: 1, correction: false, exclusions: 1 }));
const csv = () => `Date,Description,Amount\n${Array.from({ length: fixture.exclusions }, () => ",Statement footer,1").join("\n")}`;
const correctionCsv = "Date,Description,Amount,State,Type,Fee\nbad,Refund,2,unsupported,Card refund,1";
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("@/workflows/financial-review", () => ({ financialReview: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({
  rpc: async (name: string, args: Record<string, unknown>) => {
    fixture.calls.push({ name, args });
    if (name === "import_batch_candidates") return { data: fixture.correction ? [{ rowNumber: 2, hasExternalId: false, status: "pending", candidates: [] }] : [], error: null };
    return { data: name === "finish_import_run" ? "completed" : null, error: null };
  },
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

it("does not persist exclusions after cancellation or run supersession", async () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.invalid");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-key");
  fixture.status = "canceled";
  await importFile("import", "workspace", 1);
  fixture.status = "running"; fixture.version = 2;
  await importFile("import", "workspace", 1, 1);
  expect(fixture.calls.filter(call => call.name === "stage_import_rows" || call.name === "ingest_import_batch")).toHaveLength(0);
});

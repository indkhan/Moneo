import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { importFile } from "@/workflows/import-file";
import * as csvModule from "@/lib/csv";

const fixture = vi.hoisted(() => ({ total: 100, requests: [] as string[], downloads: 0, stage: null as null | { row: { rowNumber: number; status: string } }[], status: "running", version: 1, cancelAfter: 0, attempts: 0, conflict: false, badHash: false }));
const csv = () => ["Date,Description,Amount,ID", ...Array.from({ length: fixture.total }, (_, i) => `2026-10-01,Synthetic batch ${i},-1.01,row-${i}`)].join("\n");
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({
  rpc: async (name: string, args: Record<string, unknown>) => {
    fixture.requests.push(name);
    if (name !== "finish_import_run" && (fixture.status === "canceled" || args.p_run_version !== fixture.version)) return { data: null, error: { code: "57014", message: "Import worker canceled or superseded" } };
    if (name === "read_import_stage") return { data: fixture.stage?.length ?? null, error: null };
    if (name === "stage_import_rows") fixture.stage = args.p_rows as typeof fixture.stage;
    if (name === "import_batch_candidates") return { data: fixture.stage!.slice(Number(args.p_offset), Number(args.p_offset) + 250).map(item => ({ rowNumber: item.row.rowNumber, hasExternalId: false, status: item.row.status, candidates: [] })), error: null };
    if (name === "ingest_import_batch") {
      fixture.attempts++;
      if (fixture.conflict) { fixture.conflict = false; return { data: null, error: { code: "40001", message: "Import candidates changed" } }; }
      if (fixture.cancelAfter === fixture.attempts) fixture.status = "canceled";
    }
    return { data: name === "finish_import_run" ? (args.p_error ? "failed" : "completed") : null, error: null };
  },
  storage: { from: () => ({ download: async () => { fixture.downloads++; return { data: new Blob([csv()]), error: null }; } }) },
  from: (table: string) => {
    fixture.requests.push(`select:${table}`);
    const query = { select: () => query, eq: () => query,
      limit: async () => ({ data: [{ id: "account" }], error: null }),
      single: async () => ({ data: { status: fixture.status, run_version: fixture.version, storage_path: "workspace/batch.csv", file_hash: fixture.badHash ? "changed" : createHash("sha256").update(csv()).digest("hex"), route_accounts: {}, mapping: { accountName: "Synthetic", currencyCode: "EUR", dateColumn: "Date", descriptionColumn: "Description", amountColumn: "Amount", externalIdColumn: "ID", dateFormat: "iso", amountSign: "signed", numericConvention: "decimal-dot" } }, error: null }),
    }; return query;
  },
}) }));
afterEach(() => { Object.assign(fixture, { total: 100, requests: [], downloads: 0, stage: null, status: "running", version: 1, cancelAfter: 0, attempts: 0, conflict: false, badHash: false }); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function env() { vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://synthetic.invalid"); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic"); vi.stubEnv("OPENROUTER_API_KEY", ""); }

it.each([100, 1000, 10000])("downloads and normalizes %i rows once with two RPCs per bounded batch", async total => {
  env(); fixture.total = total;
  const parses = vi.spyOn(csvModule, "parseCsv"), normalizations = vi.spyOn(csvModule, "inspectRows");
  await importFile("import", "workspace", total);
  expect(fixture.downloads).toBe(1);
  expect(fixture.requests.filter(name => name === "stage_import_rows")).toHaveLength(1);
  expect(fixture.stage).toHaveLength(total);
  expect(parses).toHaveBeenCalledTimes(1); expect(normalizations).toHaveBeenCalledTimes(1);
  expect(fixture.requests).toHaveLength(6 + 2 * Math.ceil(total / 250));
  fixture.requests = [];
  await importFile("import", "workspace", total);
  expect(fixture.downloads).toBe(1);
  expect(parses).toHaveBeenCalledTimes(1); expect(normalizations).toHaveBeenCalledTimes(1);
  expect(fixture.requests).toHaveLength(3 + 2 * Math.ceil(total / 250));
});

it("stops at a committed batch boundary and resumes from retained staging with a fenced run", async () => {
  env(); fixture.total = 1000; fixture.cancelAfter = 1;
  await importFile("import", "workspace", 1000);
  expect(fixture.attempts).toBe(1);
  fixture.status = "running"; fixture.version = 2; fixture.cancelAfter = 0;
  await importFile("import", "workspace", 1000, 1);
  expect(fixture.attempts).toBe(1);
  await importFile("import", "workspace", 1000, 2);
  expect(fixture.attempts).toBe(5);
  expect(fixture.downloads).toBe(1);
});

it("refreshes stale batch candidates before retrying and refuses mismatched source bytes", async () => {
  env(); fixture.conflict = true;
  await importFile("import", "workspace", 100);
  expect(fixture.requests.filter(name => name === "import_batch_candidates")).toHaveLength(2);
  expect(fixture.attempts).toBe(2);
  fixture.stage = null; fixture.requests = []; fixture.badHash = true;
  await importFile("import", "workspace", 100);
  expect(fixture.requests).not.toContain("stage_import_rows");
  expect(fixture.requests).not.toContain("ingest_import_batch");
});

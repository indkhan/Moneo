import { expect, it, vi } from "vitest";
import { importFile } from "@/workflows/import-file";
import { createHash } from "node:crypto";

const fixture = vi.hoisted(() => ({ updates: [] as Record<string, unknown>[], effects: [] as string[] }));
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("@/workflows/financial-review", () => ({ financialReview: vi.fn() }));
vi.mock("@/lib/ai/provider", () => ({ getModel: vi.fn(() => { throw new Error("not configured"); }) }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({
  rpc: async (name: string, args: Record<string, unknown>) => { fixture.effects.push(name); if (name === "finish_import_run") fixture.updates.push({ status: "failed", error: args.p_error }); return { data: "failed", error: null }; },
  storage: { from: () => ({ download: async () => ({ data: new Blob(["Date,Description,Amount\n2026-09-01,Coffee,-2.00"]), error: null }) }) },
  from: (table: string) => {
    const query = {
      select: () => query, eq: () => query,
      update: (value: Record<string, unknown>) => { fixture.updates.push(value); return query; },
      in: async () => ({ data: null, error: null }),
      single: async () => ({ data: { status: "queued", run_version: 1, storage_path: "workspace/fixture.csv", file_hash: createHash("sha256").update("Date,Description,Amount\n2026-09-01,Coffee,-2.00").digest("hex"), mapping: {
        accountName: "Checking", currencyCode: "EUR", dateColumn: "Date", descriptionColumn: "Description",
        amountColumn: "Amount", dateFormat: "iso", amountSign: "signed",
      } }, error: null }),
      limit: async () => table === "accounts" ? ({ data: [{ id: "one" }, { id: "two" }], error: null }) : ({ data: [], error: null }),
    };
    return query;
  },
}) }));

it("refuses ambiguous account names before any ledger effect", async () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.invalid");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-key");
  try {
    await importFile("import", "workspace", 1);
    expect(fixture.updates).toContainEqual(expect.objectContaining({ status: "failed", error: expect.stringContaining("ambiguous") }));
    expect(fixture.effects).toEqual(["finish_import_run"]);
  } finally { vi.unstubAllEnvs(); }
});

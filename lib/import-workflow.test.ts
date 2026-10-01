import { expect, it, vi } from "vitest";
import { importFile } from "@/workflows/import-file";

const fixture = vi.hoisted(() => ({ updates: [] as Record<string, unknown>[] }));
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("@/workflows/financial-review", () => ({ financialReview: vi.fn() }));
vi.mock("@/lib/ai/provider", () => ({ getModel: vi.fn(() => { throw new Error("not configured"); }) }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({
  storage: { from: () => ({ download: async () => ({ data: new Blob(["Date,Description,Amount\n2026-09-01,Coffee,-2.00"]), error: null }) }) },
  from: (table: string) => {
    const query = {
      select: () => query, eq: () => query,
      update: (value: Record<string, unknown>) => { fixture.updates.push(value); return query; },
      in: async () => ({ data: null, error: null }),
      single: async () => ({ data: { status: "queued", storage_path: "fixture.csv", mapping: {
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
  } finally { vi.unstubAllEnvs(); }
});

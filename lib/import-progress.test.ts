import { expect, it, vi } from "vitest";
import { importFile } from "@/workflows/import-file";

const state = vi.hoisted(() => ({ sources: new Map<string, Record<string, unknown>>(), links: new Map<string, Record<string, unknown>>(),
  transactions: new Map<string, Record<string, unknown>>(), snapshots: new Map<string, Record<string, unknown>>(), progress: [] as number[], timestamped: false }));
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("@/workflows/financial-review", () => ({ financialReview: vi.fn() }));
vi.mock("@/lib/ai/provider", () => ({ getModel: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({
  storage: { from: () => ({ download: async () => ({ data: new Blob([
    "Date,Description,Amount,Type,Fee,Balance\n" + Array.from({ length: 27 }, (_, i) => `${state.timestamped ? `2026-10-01T10:${String(i).padStart(2,"0")}:00Z` : "2026-09-01"},Row ${i},-1.00,${i === 0 ? "Transfer" : "Card Payment"},${state.timestamped && i === 1 ? "0.10" : "0"},${state.timestamped ? String(100-i) : ""}`).join("\n"),
  ]), error: null }) }) },
  rpc: async () => { state.progress.push(state.links.size); return { data: null, error: null }; },
  from: (table: string) => {
    const filters = new Map<string, unknown>();
    let inserted: Record<string, unknown> | undefined;
    let patch: Record<string, unknown> | undefined;
    const query = {
      select: () => query, eq: (key: string, value: unknown) => { filters.set(key, value); return query; }, in: () => query,
      upsert: (value: Record<string, unknown>) => { inserted = value; return query; },
      update: (value: Record<string, unknown>) => { patch = value; return query; },
      limit: async () => ({ data: [], error: null }),
      single: async () => ({ data: table === "source_transactions" ? state.sources.get(String(filters.get("id"))) : table === "transactions" ? state.transactions.get(String(filters.get("id"))) : {
        status: "queued", storage_path: "synthetic.csv", new_rows: state.links.size, matched_rows: 0, review_rows: 0,
        mapping: { accountName: "Cash", currencyCode: "EUR", dateColumn: "Date", descriptionColumn: "Description", amountColumn: "Amount", dateFormat: "iso", amountSign: "signed", ...(state.timestamped ? { balanceColumn: "Balance" } : {}) },
      }, error: null }),
      maybeSingle: async () => ({ data: state.links.get(String(filters.get("source_transaction_id"))) ?? null, error: null }),
      then: (resolve: (result: { data: unknown[]; error: null }) => unknown) => {
        const records = table === "source_transactions" ? state.sources : table === "transaction_sources" ? state.links : table === "transactions" ? state.transactions : table === "balance_snapshots" ? state.snapshots : null;
        if (inserted && records) {
          const key = String(inserted.id ?? inserted.source_transaction_id);
          if (!records.has(key)) records.set(key, { status: "new", ...inserted });
        }
        if (patch && records) {
          const record = records.get(String(filters.get("id")));
          if (record) Object.assign(record, patch);
        }
        return Promise.resolve({ data: [], error: null }).then(resolve);
      },
    };
    return query;
  },
}) }));

it("reports persisted progress by row25 and keeps counts/idempotent ledger stable on replay", async () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.invalid");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-key");
  vi.stubEnv("OPENROUTER_API_KEY", "");
  try {
    await importFile("import", "workspace", 27);
    expect(state.progress).toEqual([25, 27, 27]);
    expect(state.transactions.size).toBe(27);
    expect([...state.transactions.values()][0]).toMatchObject({ amount_minor: "-100", kind: "ordinary", review_reasons: ["source_transfer"] });
    await importFile("import", "workspace", 27);
    expect(state.transactions.size).toBe(27);
    expect(state.sources.size).toBe(27);
    expect(state.progress.at(-1)).toBe(27);
  } finally { vi.unstubAllEnvs(); }
});

it("persists reviewed source instants and repairs a lost after-row snapshot on retry without changing ledger", async () => {
  state.sources.clear(); state.links.clear(); state.transactions.clear(); state.snapshots.clear(); state.progress.length = 0; state.timestamped = true;
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.invalid"); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-key"); vi.stubEnv("OPENROUTER_API_KEY", "");
  try {
    await importFile("timestamp-import", "workspace", 27);
    expect([...state.transactions.values()][1]).toMatchObject({ posted_at: "2026-10-01T10:01:00.000Z", amount_minor: "-100", review_reasons: ["fee_semantics"] });
    expect([...state.sources.values()][1]).toMatchObject({ fee_evidence: { treatment: "included", deltaMinor: "-100", previousRowNumber: 2 } });
    expect([...state.snapshots.values()][1]).toMatchObject({ as_of: "2026-10-01T10:01:00.000Z", boundary_kind: "after_transaction", source_transaction_id: [...state.sources.keys()][1] });
    state.snapshots.clear();
    await importFile("timestamp-import", "workspace", 27);
    expect(state.snapshots.size).toBe(27); expect(state.transactions.size).toBe(27);
  } finally { state.timestamped = false; vi.unstubAllEnvs(); }
});

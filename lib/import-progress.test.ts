import { expect, it, vi } from "vitest";
import { importFile } from "@/workflows/import-file";
import { createHash } from "node:crypto";

const state = vi.hoisted(() => ({ sources: new Map<string, Record<string, unknown>>(), links: new Map<string, Record<string, unknown>>(),
  transactions: new Map<string, Record<string, unknown>>(), snapshots: new Map<string, Record<string, unknown>>(), progress: [] as number[], importsWrites: [] as Record<string, unknown>[], timestamped: false, threeDecimal: false, accountArchived: false, importStatus: "queued", runVersion: 1, cancelAt: 0, legacyAccountId: "" }));
function syntheticCsv() { return "Date,Description,Amount,Type,Fee,Balance\n" + Array.from({ length: 27 }, (_, i) => `${state.timestamped ? `2026-10-01T10:${String(i).padStart(2,"0")}:00Z` : "2026-09-01"},Row ${i},${state.threeDecimal ? "-0.123" : "-1.00"},${i === 0 ? "Transfer" : "Card Payment"},${state.threeDecimal ? "0.001" : state.timestamped && i === 1 ? "0.10" : "0"},${state.threeDecimal ? "1.234" : state.timestamped ? String(100-i) : ""}`).join("\n"); }
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("@/workflows/financial-review", () => ({ financialReview: vi.fn() }));
vi.mock("@/lib/ai/provider", () => ({ getModel: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({
  storage: { from: () => ({ download: async () => ({ data: new Blob([syntheticCsv()]), error: null }) }) },
  rpc: async (name: string, args: Record<string, unknown>) => {
    if (name === "finish_import_run") {
      if (args.p_run_version === state.runVersion && ["queued", "running"].includes(state.importStatus)) {
        state.importStatus = args.p_error ? "failed" : "completed";
        state.importsWrites.push({ status: state.importStatus, error: args.p_error }); state.progress.push(state.links.size);
      }
      return { data: state.importStatus, error: null };
    }
    if (args.p_run_version !== state.runVersion || !["queued", "running"].includes(state.importStatus)) return { data: null, error: { message: "Import worker canceled or superseded", code: "57014" } };
    if (name === "prepare_import_route") { state.importStatus = "running"; return { data: null, error: null }; }
    const row = args.p_row as Record<string, unknown>;
    const sourceId = String(row.sourceId), transactionId = String(row.transactionId);
    if (!state.sources.has(sourceId)) state.sources.set(sourceId, { id: sourceId, row_number: row.rowNumber, status: row.action, original_row: row.originalRow, fee_evidence: row.feeEvidence, review_reasons: row.reviewReasons });
    if (!state.transactions.has(transactionId)) state.transactions.set(transactionId, { id: transactionId, account_id: args.p_account_id, amount_minor: row.amountMinor, posted_at: row.postedAt, kind: row.kind, review_reasons: row.reviewReasons });
    if (!state.links.has(sourceId)) state.links.set(sourceId, { transaction_id: transactionId, source_transaction_id: sourceId });
    if (row.balanceMinor !== null) state.snapshots.set(String(row.balanceId), { amount_minor: row.balanceMinor, as_of: row.balanceAsOf, boundary_kind: row.postedAt ? "after_transaction" : "date_only", source_transaction_id: sourceId });
    if (row.reportProgress) {
      state.progress.push(state.links.size);
      if (state.cancelAt && state.links.size >= state.cancelAt) { state.importStatus = "canceled"; state.runVersion++; }
    }
    return { data: { action: row.action }, error: null };
  },
  from: (table: string) => {
    const filters = new Map<string, unknown>();
    let inserted: Record<string, unknown> | undefined;
    let patch: Record<string, unknown> | undefined;
    const query = {
      select: () => query, order: () => query, eq: (key: string, value: unknown) => { filters.set(key, value); return query; }, in: () => query,
      range: async () => ({ data: [...state.sources.values()].map(source => ({ row_number: source.row_number, transaction_sources: [{ transactions: { account_id: state.legacyAccountId } }] })), error: null }),
      upsert: (value: Record<string, unknown>) => { inserted = value; return query; },
      update: (value: Record<string, unknown>) => { patch = value; if (table === "imports") state.importsWrites.push(value); return query; },
      limit: async () => ({ data: state.accountArchived ? [{ id: "archived", archived_at: "2026-10-01T00:00:00Z" }] : table === "accounts" && state.legacyAccountId && filters.get("id") === state.legacyAccountId ? [{ id: state.legacyAccountId, archived_at: null }] : [], error: null }),
      single: async () => ({ data: table === "data_sources" ? { account_id: state.legacyAccountId } : table === "source_transactions" ? state.sources.get(String(filters.get("id"))) : table === "transactions" ? state.transactions.get(String(filters.get("id"))) : {
        status: state.importStatus, run_version: state.runVersion, source_id: state.legacyAccountId ? "legacy-source" : null, storage_path: "workspace/synthetic.csv", file_hash: createHash("sha256").update(syntheticCsv()).digest("hex"), new_rows: state.links.size, matched_rows: 0, review_rows: 0,
        mapping: { accountName: "Cash", currencyCode: state.threeDecimal ? "KWD" : "EUR", dateColumn: "Date", descriptionColumn: "Description", amountColumn: "Amount", dateFormat: "iso", amountSign: "signed", ...(state.timestamped ? { balanceColumn: "Balance" } : {}), ...(state.threeDecimal ? { numericConvention: "decimal-dot", parserVersion: "numeric-convention-v2" } : {}) },
      }, error: null }),
      maybeSingle: async () => ({ data: (table === "source_transactions" ? state.sources.get(String(filters.get("id"))) : state.links.get(String(filters.get("source_transaction_id")))) ?? null, error: null }),
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

it("writes reviewed three-decimal amounts, fees and balances as exact strings with original evidence", async () => {
  state.sources.clear(); state.links.clear(); state.transactions.clear(); state.snapshots.clear(); state.timestamped = true; state.threeDecimal = true; state.importStatus = "queued";
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.invalid"); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-key"); vi.stubEnv("OPENROUTER_API_KEY", "");
  try {
    await importFile("decimal-import", "workspace", 27);
    expect(state.importStatus).toBe("completed");
    expect([...state.transactions.values()][1].amount_minor).toBe("-123");
    expect([...state.snapshots.values()][1].amount_minor).toBe("1234");
    expect([...state.sources.values()][1]).toMatchObject({ original_row: { Amount: "-0.123", Fee: "0.001", Balance: "1.234" }, fee_evidence: { feeMinor: "1" } });
  } finally {
    state.sources.clear(); state.links.clear(); state.transactions.clear(); state.snapshots.clear(); state.progress.length = 0; state.importsWrites = [];
    state.timestamped = false; state.threeDecimal = false; state.importStatus = "queued"; vi.unstubAllEnvs();
  }
});

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

it("stops row effects at effective cancellation and resumes the same sources without duplicate ledger", async () => {
  state.sources.clear(); state.links.clear(); state.transactions.clear(); state.snapshots.clear(); state.progress.length = 0;
  state.importStatus = "queued"; state.runVersion = 1; state.cancelAt = 25;
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.invalid"); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-key"); vi.stubEnv("OPENROUTER_API_KEY", "");
  try {
    await importFile("cancel-import", "workspace", 27);
    expect(state.importStatus).toBe("canceled"); expect(state.sources.size).toBe(25); expect(state.transactions.size).toBe(25);
    const first = structuredClone([...state.sources.values()][0]);
    state.legacyAccountId = String([...state.transactions.values()][0].account_id); // A paused legacy account was renamed; name lookup no longer finds it.
    state.cancelAt = 0; state.importStatus = "queued"; state.runVersion = 3;
    await importFile("cancel-import", "workspace", 27, 3);
    expect(state.sources.size).toBe(27); expect(state.transactions.size).toBe(27);
    expect([...state.sources.values()][0]).toEqual(first);
    expect([...state.transactions.values()].every(row => row.account_id === state.legacyAccountId)).toBe(true);
  } finally { state.legacyAccountId = ""; state.cancelAt = 0; state.importStatus = "queued"; state.runVersion = 1; vi.unstubAllEnvs(); }
});

it("refuses an archived reviewed target before writing any source or canonical row", async () => {
  state.sources.clear(); state.transactions.clear(); state.links.clear(); state.importsWrites = []; state.accountArchived = true; state.importStatus = "queued";
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.invalid"); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-key"); vi.stubEnv("OPENROUTER_API_KEY", "");
  try {
    await importFile("archive-import", "workspace", 27);
    expect(state.importsWrites).toContainEqual({ status: "failed", error: "Error: Archived accounts cannot receive new imports" });
    expect(state.sources.size).toBe(0); expect(state.transactions.size).toBe(0);
  } finally { state.accountArchived = false; state.importStatus = "queued"; vi.unstubAllEnvs(); }
});

it("persists reviewed source instants and repairs a lost after-row snapshot on retry without changing ledger", async () => {
  state.sources.clear(); state.links.clear(); state.transactions.clear(); state.snapshots.clear(); state.progress.length = 0; state.timestamped = true; state.importStatus = "queued";
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.invalid"); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-key"); vi.stubEnv("OPENROUTER_API_KEY", "");
  try {
    await importFile("timestamp-import", "workspace", 27);
    expect([...state.transactions.values()][1]).toMatchObject({ posted_at: "2026-10-01T10:01:00.000Z", amount_minor: "-100", review_reasons: ["fee_semantics"] });
    expect([...state.sources.values()][1]).toMatchObject({ fee_evidence: { treatment: "included", feeMinor: "10", deltaMinor: "-100", previousRowNumber: 2 } });
    expect([...state.snapshots.values()][1]).toMatchObject({ as_of: "2026-10-01T10:01:00.000Z", boundary_kind: "after_transaction", source_transaction_id: [...state.sources.keys()][1] });
    state.snapshots.clear();
    state.importStatus = "queued"; // Recover a legacy partial import whose snapshot effect was lost before the atomic writer existed.
    await importFile("timestamp-import", "workspace", 27);
    expect(state.snapshots.size).toBe(27); expect(state.transactions.size).toBe(27);
  } finally { state.timestamped = false; vi.unstubAllEnvs(); }
});

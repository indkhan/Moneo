import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { enableBankingClient, EnableBankingError, type BankTransaction } from "@/lib/bank/enable-banking";
import { serviceDb } from "@/lib/bank/server";
import { importFile } from "@/workflows/import-file";
import { syncBankConnection } from "./bank-sync";

vi.mock("@/workflows/import-file", () => ({ importFile: vi.fn() }));
vi.mock("@/lib/settings", () => ({ loadWorkspaceSettings: async () => ({ timezone: "Europe/Berlin" }) }));
vi.mock("@/lib/bank/server", () => ({ serviceDb: vi.fn() }));
vi.mock("@/lib/bank/enable-banking", async original => ({ ...await original<typeof import("@/lib/bank/enable-banking")>(), enableBankingClient: vi.fn() }));

// A minimal in-memory Supabase: the imports(workspace_id, file_hash) unique index is what makes a repeated sync a no-op.
type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
function table(name: string) {
  const filters: [string, unknown][] = [];
  let patch: Row | undefined, insert: Row | undefined;
  const rows = () => tables[name].filter(row => filters.every(([column, value]) => row[column] === value));
  const run = () => {
    if (insert) {
      if (name === "imports" && tables.imports.some(row => row.file_hash === insert!.file_hash && row.status !== "undone")) return { data: null, error: { code: "23505", message: "duplicate" } };
      const row = { id: `import-${tables[name].length + 1}`, ...insert };
      tables[name].push(row);
      return { data: row, error: null };
    }
    if (patch) { rows().forEach(row => Object.assign(row, patch)); return { data: null, error: null }; }
    return { data: rows(), error: null };
  };
  const builder = {
    select: () => builder, neq: () => builder,
    eq: (column: string, value: unknown) => { filters.push([column, value]); return builder; },
    insert: (row: Row) => { insert = row; return builder; },
    update: (row: Row) => { patch = row; return builder; },
    single: async () => { const result = run(); return Array.isArray(result.data) ? { data: result.data[0], error: result.data[0] ? null : { message: "missing" } } : result; },
    then: (resolve: (value: unknown) => void) => resolve(run()),
  };
  return builder;
}

const tx = (id: string, date: string, amount: string): BankTransaction => ({ entry_reference: id, transaction_amount: { currency: "EUR", amount },
  credit_debit_indicator: "DBIT", status: "BOOK", booking_date: date, remittance_information: [`Card ${id}`] });
let bank: { balances: ReturnType<typeof vi.fn>; bookedTransactions: ReturnType<typeof vi.fn> };

beforeEach(() => {
  tables = {
    bank_connections: [{ id: "c1", workspace_id: "w1", status: "active", valid_until: "2099-01-01T00:00:00Z", last_error: null }],
    bank_connection_accounts: [{ connection_id: "c1", provider_account_uid: "u1", currency_code: "EUR", account_name: "Revolut ••1234", last_booked_on: null }],
    imports: [],
  };
  vi.mocked(serviceDb).mockReturnValue({ from: table, storage: { from: () => ({ upload: async () => ({ error: null }) }) } } as never);
  bank = { balances: vi.fn().mockResolvedValue([]), bookedTransactions: vi.fn().mockResolvedValue([tx("a", "2026-10-01", "5.00"), tx("b", "2026-10-02", "7.25")]) };
  vi.mocked(enableBankingClient).mockReturnValue(bank as never);
  vi.mocked(importFile).mockImplementation(async importId => { tables.imports.find(row => row.id === importId)!.status = "completed"; });
});
afterEach(() => vi.clearAllMocks());

it("syncing the same bank data twice adds no second import", async () => {
  await syncBankConnection("c1", "w1");
  await syncBankConnection("c1", "w1");
  expect(tables.imports).toHaveLength(1);
  expect(importFile).toHaveBeenCalledTimes(1);
  expect(importFile).toHaveBeenCalledWith("import-1", "w1", 2, 1);
  expect(tables.imports[0].mapping).toMatchObject({ externalIdColumn: "id", accountName: "Revolut ••1234", currencyCode: "EUR" });
  expect(tables.bank_connection_accounts[0].last_booked_on).toBe("2026-10-02");
  expect(bank.bookedTransactions).toHaveBeenLastCalledWith("u1", "2026-09-25", undefined);
  expect(tables.bank_connections[0]).toMatchObject({ status: "active", last_error: null });
});

it("records progress when work after a completed import fails", async () => {
  // importFile is flattened into this run: its optional tail (first review, agent team) can throw after the rows are in.
  vi.mocked(importFile).mockImplementationOnce(async importId => {
    tables.imports.find(row => row.id === importId)!.status = "completed";
    throw new Error("Selected model is unavailable");
  });
  await syncBankConnection("c1", "w1");
  expect(tables.bank_connection_accounts[0].last_booked_on).toBe("2026-10-02");
  expect(tables.bank_connections[0].last_synced_at).toEqual(expect.any(String));
});

it("marks an expired consent and records rate limits without importing", async () => {
  bank.bookedTransactions.mockRejectedValueOnce(new EnableBankingError(429, undefined, "limited"));
  await syncBankConnection("c1", "w1");
  expect(tables.bank_connections[0]).toMatchObject({ status: "active", last_error: "The bank rate limit was reached; the next sync will retry" });
  bank.bookedTransactions.mockRejectedValueOnce(new EnableBankingError(401, "EXPIRED_SESSION", "expired"));
  await syncBankConnection("c1", "w1");
  expect(tables.bank_connections[0].status).toBe("expired");
  expect(importFile).not.toHaveBeenCalled();
});

it("marks the sync running until it finishes", async () => {
  vi.mocked(importFile).mockImplementationOnce(async importId => {
    const connection = tables.bank_connections[0];
    expect(connection.sync_started_at).toEqual(expect.any(String));
    expect(connection.last_synced_at).toBeUndefined();
    tables.imports.find(row => row.id === importId)!.status = "completed";
  });
  await syncBankConnection("c1", "w1");
  const connection = tables.bank_connections[0];
  expect(Date.parse(connection.last_synced_at as string)).toBeGreaterThanOrEqual(Date.parse(connection.sync_started_at as string));
});

it("asks for full history on the first sync and falls back to 90 days when the bank refuses", async () => {
  await syncBankConnection("c1", "w1");
  expect(bank.bookedTransactions).toHaveBeenNthCalledWith(1, "u1", "2000-01-01", undefined);
  tables.bank_connection_accounts[0].last_booked_on = null;
  bank.bookedTransactions.mockClear().mockRejectedValueOnce(new EnableBankingError(400, "WRONG_TRANSACTIONS_PERIOD", "too old"));
  await syncBankConnection("c1", "w1");
  expect(bank.bookedTransactions).toHaveBeenCalledTimes(2);
  expect(bank.bookedTransactions.mock.calls[1][1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(bank.bookedTransactions.mock.calls[1][1]).not.toBe("2000-01-01");
});

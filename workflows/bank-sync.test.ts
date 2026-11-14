import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { start } from "workflow/api";
import { enableBankingClient, EnableBankingError, type BankTransaction, type PsuContext } from "@/lib/bank/enable-banking";
import { serviceDb } from "@/lib/bank/server";
import { claimBankSync } from "@/lib/bank/sync-lease";
import { importFile } from "@/workflows/import-file";
import { startSyncAgentRun } from "@/lib/import/follow-up";
import { retryFirstBankSync, syncBankConnection } from "./bank-sync";

vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("@/workflows/import-file", () => ({ importFile: vi.fn() }));
vi.mock("@/lib/bank/server", () => ({ serviceDb: vi.fn() }));
vi.mock("@/lib/import/follow-up", () => ({ startSyncAgentRun: vi.fn() }));
vi.mock("@/lib/bank/enable-banking", async original => ({ ...await original<typeof import("@/lib/bank/enable-banking")>(), enableBankingClient: vi.fn() }));

// A minimal in-memory Supabase: the imports(workspace_id, file_hash) unique index is what makes a repeated sync a no-op.
type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
function table(name: string) {
  const filters: [string, unknown][] = [];
  let patch: Row | undefined, insert: Row | undefined, upsert: Row[] | undefined;
  const rows = () => tables[name].filter(row => filters.every(([column, value]) => row[column] === value));
  const run = () => {
    if (insert) {
      if (name === "imports" && tables.imports.some(row => row.file_hash === insert!.file_hash && row.status !== "undone")) return { data: null, error: { code: "23505", message: "duplicate" } };
      const row = { id: `import-${tables[name].length + 1}`, ...insert };
      tables[name].push(row);
      return { data: row, error: null };
    }
    if (upsert) {
      // bank_transaction_raw primary key (import_id, row_number), ignoreDuplicates.
      for (const row of upsert) if (!tables[name].some(have => have.import_id === row.import_id && have.row_number === row.row_number)) tables[name].push(row);
      return { data: null, error: null };
    }
    if (patch) { rows().forEach(row => Object.assign(row, patch)); return { data: null, error: null }; }
    return { data: rows(), error: null };
  };
  const builder = {
    select: () => builder, neq: () => builder,
    eq: (column: string, value: unknown) => { filters.push([column, value]); return builder; },
    insert: (row: Row) => { insert = row; return builder; },
    update: (row: Row) => { patch = row; return builder; },
    upsert: (rows: Row[]) => { upsert = rows; return builder; },
    single: async () => { const result = run(); return Array.isArray(result.data) ? { data: result.data[0], error: result.data[0] ? null : { message: "missing" } } : result; },
    maybeSingle: async () => ({ data: (run().data as Row[])[0] ?? null, error: null }),
    then: (resolve: (value: unknown) => void) => resolve(run()),
  };
  return builder;
}

const tx = (id: string, date: string, amount: string): BankTransaction => ({ entry_reference: id, transaction_amount: { currency: "EUR", amount },
  credit_debit_indicator: "DBIT", status: "BOOK", booking_date: date, remittance_information: [`Card ${id}`] });
let bank: { balances: ReturnType<typeof vi.fn>; bookedTransactions: ReturnType<typeof vi.fn>; application: ReturnType<typeof vi.fn> };
let rpc: ReturnType<typeof vi.fn>;
const now = Date.parse("2026-11-13T12:00:00Z");
const PSU: PsuContext = { ip: "127.0.0.1", userAgent: "test" };
// claim_bank_sync and hold_bank_sync as the database runs them (supabase/tests/bank-sync-lease.sql).
const LEASE_MS = 15 * 60_000;
async function lease(name: string, args: Record<string, string>) {
  const connection = tables.bank_connections.find(row => row.id === args.p_connection_id)!;
  const until = connection.sync_lease_until as number | undefined;
  if (name === "claim_bank_sync") {
    const free = connection.status === "active" && (!until || until < Date.now());
    if (free) Object.assign(connection, { sync_lease_token: args.p_token, sync_lease_until: Date.now() + LEASE_MS, sync_started_at: new Date().toISOString() });
    return { data: free, error: null };
  }
  const held = connection.sync_lease_token === args.p_token && !!until && until >= Date.now();
  if (held) connection.sync_lease_until = Date.now() + LEASE_MS;
  return { data: held, error: null };
}
// What every trigger does: take the lease, then run the sync with it. Owner present unless said otherwise.
async function sync(psu: PsuContext | undefined = PSU) {
  const token = await claimBankSync(serviceDb(), "c1", "w1");
  expect(token).toEqual(expect.any(String));
  await syncBankConnection("c1", "w1", token!, psu);
}

beforeEach(() => {
  tables = {
    bank_connections: [{ id: "c1", workspace_id: "w1", status: "active", valid_until: "2099-01-01T00:00:00Z", last_error: null }],
    bank_connection_accounts: [{ connection_id: "c1", workspace_id: "w1", iban: "DE89370400440532013000", provider_account_uid: "u1", currency_code: "EUR", account_name: "Revolut ••1234", last_booked_on: null }],
    imports: [], workspace_settings: [], bank_transaction_raw: [], own_account_identifiers: [{ workspace_id: "w1", iban: "NL91ABNA0417164300" }],
  };
  vi.useFakeTimers({ now, toFake: ["Date"] });
  rpc = vi.fn(async (name: string, args: Record<string, string>) => name.endsWith("_bank_sync") ? lease(name, args) : { error: null });
  vi.mocked(serviceDb).mockReturnValue({ from: table, rpc, storage: { from: () => ({ upload: async () => ({ error: null }) }) } } as never);
  bank = { application: vi.fn().mockResolvedValue({}), balances: vi.fn().mockResolvedValue([]), bookedTransactions: vi.fn().mockResolvedValue([tx("a", "2026-10-01", "5.00"), tx("b", "2026-10-02", "7.25")]) };
  vi.mocked(enableBankingClient).mockResolvedValue(bank as never);
  vi.mocked(importFile).mockImplementation(async importId => { tables.imports.find(row => row.id === importId)!.status = "completed"; });
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it("syncing the same bank data twice adds no second import", async () => {
  await sync();
  await sync();
  expect(tables.imports).toHaveLength(1);
  expect(importFile).toHaveBeenCalledTimes(1);
  expect(importFile).toHaveBeenCalledWith("import-1", "w1", 2, 1, false);
  expect(tables.imports[0].mapping).toMatchObject({ externalIdColumn: "id", accountName: "Revolut ••1234", currencyCode: "EUR" });
  expect(tables.bank_connection_accounts[0].last_booked_on).toBe("2026-10-02");
  expect(bank.bookedTransactions).toHaveBeenLastCalledWith("u1", "2026-09-25", PSU);
  expect(tables.bank_connections[0]).toMatchObject({ status: "active", last_error: null });
});

it("stores the bank's full data once per CSV row, and a repeated window adds none", async () => {
  bank.bookedTransactions.mockResolvedValue([
    { ...tx("b", "2026-10-02", "7.25"), bank_transaction_code: { code: "TRANSFER" }, creditor: { name: "Savings" }, creditor_account: { iban: "NL91 ABNA 0417 1643 00" } },
    { ...tx("a", "2026-10-01", "5.00"), bank_transaction_code: { code: "CARD_PAYMENT" }, merchant_category_code: "5411" }]);
  await sync();
  // Row numbers follow the CSV's sorted order (a, then b), not the bank's order; the header is row 1.
  expect(tables.bank_transaction_raw.map(row => [row.import_id, row.row_number, row.bank_id, row.payment_type, row.mcc, row.own_account])).toEqual([
    ["import-1", 2, "a", "card", "5411", false], ["import-1", 3, "b", "transfer", null, true]]);
  expect(tables.bank_transaction_raw[1].raw).toMatchObject({ entry_reference: "b", bank_transaction_code: { code: "TRANSFER" } });
  await sync();
  expect(tables.imports).toHaveLength(1);
  expect(tables.bank_transaction_raw).toHaveLength(2);
});

it("stores the raw rows of an import an earlier attempt left queued, without duplicating them", async () => {
  vi.mocked(importFile).mockImplementationOnce(async () => { throw new Error("crashed"); });
  await sync();
  expect(tables.imports[0].status).toBe("queued");
  await sync();
  expect(tables.imports).toHaveLength(1);
  expect(tables.bank_transaction_raw.map(row => row.row_number)).toEqual([2, 3]);
});

it("records progress when work after a completed import fails", async () => {
  // importFile is flattened into this run: its optional tail (first review, agent team) can throw after the rows are in.
  vi.mocked(importFile).mockImplementationOnce(async importId => {
    tables.imports.find(row => row.id === importId)!.status = "completed";
    throw new Error("Selected model is unavailable");
  });
  await sync();
  expect(tables.bank_connection_accounts[0].last_booked_on).toBe("2026-10-02");
  expect(tables.bank_connections[0].last_synced_at).toEqual(expect.any(String));
});

it("does not publish a successful sync when an import failed, and keeps the problem until one lands", async () => {
  vi.mocked(importFile).mockImplementationOnce(async importId => { tables.imports.find(row => row.id === importId)!.status = "failed"; });
  tables.bank_connections[0].last_synced_at = "2026-01-01T00:00:00Z";
  await sync();
  expect(tables.bank_connections[0]).toMatchObject({ last_synced_at: "2026-01-01T00:00:00Z", last_error: expect.stringContaining("did not finish"), sync_started_at: null });
  expect(tables.bank_connections[0].last_attempted_at).toEqual(expect.any(String));
  expect(tables.bank_connection_accounts[0].last_booked_on).toBeNull();
  tables.imports[0].status = "queued";
  await sync();
  expect(tables.bank_connections[0].last_error).toBeNull();
  expect(tables.bank_connections[0].last_synced_at).not.toBe("2026-01-01T00:00:00Z");
});

it("does not publish a sync when the bank refused, and leaves an ended consent's reason in place", async () => {
  tables.bank_connections[0].last_synced_at = "2026-01-01T00:00:00Z";
  bank.bookedTransactions.mockRejectedValueOnce(new EnableBankingError(500, undefined, "down"));
  await sync();
  expect(tables.bank_connections[0].last_synced_at).toBe("2026-01-01T00:00:00Z");
  expect(tables.bank_connections[0].last_error).toEqual(expect.any(String));
  tables.bank_connection_accounts[0].next_allowed_at = null;
  bank.bookedTransactions.mockRejectedValueOnce(new EnableBankingError(401, "EXPIRED_SESSION", "expired"));
  await sync();
  expect(tables.bank_connections[0]).toMatchObject({ status: "expired", last_synced_at: "2026-01-01T00:00:00Z", last_error: expect.stringContaining("consent expired") });
});

it("saves the bank's balance even when no transaction arrives", async () => {
  bank.balances.mockResolvedValue([{ balance_type: "CLBD", reference_date: "2026-10-02", balance_amount: { currency: "EUR", amount: "12.34" } }]);
  bank.bookedTransactions.mockResolvedValue([]);
  await sync();
  expect(importFile).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenCalledWith("record_bank_balance", expect.objectContaining({ p_connection_id: "c1", p_account_name: "Revolut ••1234", p_amount_minor: "1234", p_balance_type: "CLBD", p_as_of: "2026-10-01T22:00:00.000Z" }));
  expect(tables.bank_connections[0].last_error).toBeNull();
});

// A 429 on the first account ended the whole sync, so the second account never landed.
it("keeps syncing the other accounts when one is rate limited, and holds that one until the bank's Retry-After", async () => {
  tables.bank_connection_accounts.push({ connection_id: "c1", provider_account_uid: "u2", currency_code: "EUR", account_name: "Revolut ••5678", last_booked_on: "2026-09-30" });
  bank.bookedTransactions.mockImplementation(async (uid: string) => {
    if (uid === "u1") throw new EnableBankingError(429, undefined, "limited", 120);
    return [tx(`${uid}-a`, "2026-10-01", "5.00")];
  });
  await sync();
  const [limited, other] = tables.bank_connection_accounts;
  expect(other.last_booked_on).toBe("2026-10-01");
  expect(importFile).toHaveBeenCalledOnce();
  expect(limited).toMatchObject({ last_booked_on: null, next_allowed_at: new Date(now + 120_000).toISOString(), last_error: expect.stringContaining("rate limit") });
  expect(tables.bank_connections[0]).toMatchObject({ status: "active", last_error: expect.stringContaining("Revolut ••1234") });
  // Opening Moneo again within those two minutes leaves the limited account alone.
  bank.bookedTransactions.mockClear();
  await sync();
  expect(bank.bookedTransactions.mock.calls.map(call => call[0])).toEqual(["u2"]);
});

// Every 401 marked the consent expired, though a wrong App ID, key or clock answers 401 too.
it("asks Enable Banking about the app before calling an unexplained 401 an ended consent", async () => {
  bank.bookedTransactions.mockRejectedValueOnce(new EnableBankingError(401, "UNAUTHORIZED", "refused"));
  bank.application.mockRejectedValueOnce(new EnableBankingError(401, "UNAUTHORIZED", "refused"));
  await sync();
  expect(tables.bank_connections[0]).toMatchObject({ status: "active", last_error: expect.stringContaining("App ID or private key") });
  // The hourly job doesn't ask again with the same rejected key for 6 hours.
  expect(tables.bank_connection_accounts[0]).toMatchObject({ next_allowed_at: new Date(now + 6 * 3_600_000).toISOString() });
  expect(tables.bank_connection_accounts[0].last_error ?? null).toBeNull();
  bank.bookedTransactions.mockClear();
  await sync(undefined);
  expect(bank.bookedTransactions).not.toHaveBeenCalled();
  // Saving new credentials lifts that wait (app/api/bank/credentials).
  tables.bank_connection_accounts[0].next_allowed_at = null;
  bank.bookedTransactions.mockRejectedValueOnce(new EnableBankingError(401, "UNAUTHORIZED", "refused"));
  await sync();
  expect(tables.bank_connections[0]).toMatchObject({ status: "expired", last_error: expect.stringContaining("consent expired") });
  expect(importFile).not.toHaveBeenCalled();
});

// A sync that outlived its lease finished after a newer one started and moved the cursor past rows that never landed.
it("does not move the cursor or publish when its lease ran out and another sync took over", async () => {
  vi.mocked(importFile).mockImplementationOnce(async importId => {
    tables.imports.find(row => row.id === importId)!.status = "completed";
    vi.setSystemTime(now + LEASE_MS + 1);
    expect(await claimBankSync(serviceDb(), "c1", "w1")).toEqual(expect.any(String));
  });
  await sync();
  expect(tables.bank_connection_accounts[0].last_booked_on).toBeNull();
  expect(tables.bank_connections[0].last_synced_at).toBeUndefined();
});

// Banks share full history only near consent: a first sync that hit an outage left the account without its history.
it("retries a first sync that failed for a passing reason, at most three times", async () => {
  const sleep = vi.fn(async (until: Date) => { vi.setSystemTime(until); });
  (globalThis as Record<symbol, unknown>)[Symbol.for("WORKFLOW_SLEEP")] = sleep;
  try {
    bank.bookedTransactions.mockRejectedValue(new EnableBankingError(503, undefined, "down"));
    await sync();
    for (let runs = 1; runs < 10 && vi.mocked(start).mock.calls.length === runs; runs++)
      await retryFirstBankSync(...(vi.mocked(start).mock.calls[runs - 1][1] as Parameters<typeof retryFirstBankSync>));
    expect(start).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(bank.bookedTransactions).toHaveBeenCalledTimes(4);
    expect(Date.now() - now).toBeLessThanOrEqual(65 * 60_000);
    expect(tables.bank_connections[0]).toMatchObject({ status: "active", last_error: expect.stringContaining("history hasn't been fetched yet") });
  } finally { delete (globalThis as Record<symbol, unknown>)[Symbol.for("WORKFLOW_SLEEP")]; }
});

it("marks the sync running until it finishes", async () => {
  vi.mocked(importFile).mockImplementationOnce(async importId => {
    const connection = tables.bank_connections[0];
    expect(connection.sync_started_at).toEqual(expect.any(String));
    expect(connection.last_synced_at).toBeUndefined();
    tables.imports.find(row => row.id === importId)!.status = "completed";
  });
  await sync();
  const connection = tables.bank_connections[0];
  expect(Date.parse(connection.last_synced_at as string)).toBeGreaterThanOrEqual(Date.parse(connection.sync_started_at as string));
});

it("asks for full history on the first sync and falls back to 90 days when the bank refuses", async () => {
  await sync();
  expect(bank.bookedTransactions).toHaveBeenNthCalledWith(1, "u1", "2000-01-01", PSU);
  tables.bank_connection_accounts[0].last_booked_on = null;
  bank.bookedTransactions.mockClear().mockRejectedValueOnce(new EnableBankingError(400, "WRONG_TRANSACTIONS_PERIOD", "too old"));
  await sync();
  expect(bank.bookedTransactions).toHaveBeenCalledTimes(2);
  expect(bank.bookedTransactions.mock.calls[1][1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(bank.bookedTransactions.mock.calls[1][1]).not.toBe("2000-01-01");
});

// A bank with two accounts started two agent runs, each seeing one account.
it("requests one agent pass after every account is imported", async () => {
  tables.bank_connection_accounts.push({ connection_id: "c1", provider_account_uid: "u2", currency_code: "EUR", account_name: "Revolut ••5678", last_booked_on: null });
  bank.bookedTransactions.mockImplementation(async (uid: string) => [tx(`${uid}-a`, "2026-10-01", "5.00")]);
  await sync();
  expect(importFile).toHaveBeenCalledTimes(2);
  expect(vi.mocked(importFile).mock.calls.every(call => call[4] === false)).toBe(true);
  expect(startSyncAgentRun).toHaveBeenCalledOnce();
  expect(startSyncAgentRun).toHaveBeenCalledWith(expect.anything(), "w1", ["import-1", "import-2"]);
  expect(vi.mocked(startSyncAgentRun).mock.invocationCallOrder[0]).toBeGreaterThan(Math.max(...vi.mocked(importFile).mock.invocationCallOrder));
});

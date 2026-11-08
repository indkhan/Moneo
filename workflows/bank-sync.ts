"use workflow";

import { createHash } from "node:crypto";
import { EnableBankingError, enableBankingClient, type EnableBankingClient, type PsuContext } from "@/lib/bank/enable-banking";
import { bankObservation, bankStatement } from "@/lib/bank/statement";
import { serviceDb } from "@/lib/bank/server";
import { loadWorkspaceSettings } from "@/lib/settings";
import { importFile } from "@/workflows/import-file";

type BankImport = { importId: string; rowCount: number; uid: string; lastBookedOn: string };
type BankObservation = { accountName: string; currencyCode: string; amountMinor: string; balanceType: string; asOf: string };

// One sync = one ordinary import per bank account, run through the existing import workflow
// so dedupe (bank id as external_id), review, undo and source history are unchanged.
export async function syncBankConnection(connectionId: string, workspaceId: string, psu?: PsuContext) {
  "use workflow";
  const { imports, observations, error, ended } = await stageBankImports(connectionId, workspaceId, psu);
  for (const item of imports) {
    // importFile runs flattened into this run, so a throw from its optional tail (first review,
    // agent team) would end the sync here. The import's stored status is the truth; finishBankSync reads it.
    try { await importFile(item.importId, workspaceId, item.rowCount, 1); } catch {}
  }
  await finishBankSync(connectionId, workspaceId, imports, observations, error, ended);
}

function isoDay(date: Date) { return date.toISOString().slice(0, 10); }
function daysBefore(day: string, days: number) { return isoDay(new Date(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000)); }

// Banks decide how far back they answer; under PSD2 most share full history only shortly after
// consent (when the first sync runs) and about 90 days after that. So with no cursor ask for
// everything, falling back to 90 days for banks that reject an old date_from.
const FULL_HISTORY_FROM = "2000-01-01";
async function bookedSince(client: EnableBankingClient, uid: string, lastBookedOn: string | null, today: string, psu?: PsuContext) {
  // Re-fetch a week of overlap: late-booked rows dedupe on the bank id.
  if (lastBookedOn) return client.bookedTransactions(uid, daysBefore(lastBookedOn, 7), psu);
  try { return await client.bookedTransactions(uid, FULL_HISTORY_FROM, psu); } catch (error) {
    if (!(error instanceof EnableBankingError) || error.expired || error.rateLimited || error.status < 400 || error.status >= 500) throw error;
    return client.bookedTransactions(uid, daysBefore(today, 90), psu);
  }
}

async function stageBankImports(connectionId: string, workspaceId: string, psu?: PsuContext): Promise<{ imports: BankImport[]; observations: BankObservation[]; error: string | null; ended: boolean }> {
  "use step";
  const db = serviceDb();
  const connection = await db.from("bank_connections").select("status, valid_until").eq("id", connectionId).eq("workspace_id", workspaceId).single();
  if (connection.error) throw new Error(connection.error.message);
  if (connection.data.status !== "active") return { imports: [], observations: [], error: null, ended: true };
  if (Date.parse(connection.data.valid_until) <= Date.now()) {
    await db.from("bank_connections").update({ status: "expired", last_error: "Bank consent expired; reconnect to keep syncing" }).eq("id", connectionId);
    return { imports: [], observations: [], error: null, ended: true };
  }
  // Marks the sync as running for the UI until finishBankSync sets last_synced_at.
  const started = await db.from("bank_connections").update({ sync_started_at: new Date().toISOString() }).eq("id", connectionId).eq("workspace_id", workspaceId);
  if (started.error) throw new Error(started.error.message);
  const accounts = await db.from("bank_connection_accounts").select("provider_account_uid, currency_code, account_name, last_booked_on").eq("connection_id", connectionId);
  if (accounts.error) throw new Error(accounts.error.message);
  const settings = await loadWorkspaceSettings(db, workspaceId);
  const client = await enableBankingClient();
  const today = isoDay(new Date());
  const imports: BankImport[] = [];
  const observations: BankObservation[] = [];
  try {
    for (const account of accounts.data) {
      const observation = bankObservation(await client.balances(account.provider_account_uid, psu), account.currency_code, new Date(), settings.timezone);
      if (observation) observations.push({ accountName: account.account_name, currencyCode: account.currency_code, ...observation });
      const transactions = await bookedSince(client, account.provider_account_uid, account.last_booked_on, today, psu);
      const statement = bankStatement(transactions, { accountName: account.account_name, currencyCode: account.currency_code, calendarTimezone: settings.timezone });
      if (!statement) continue;
      if (statement.rowCount > 10_000) throw new Error("Bank returned more than 10,000 transactions for one account");
      const bytes = Buffer.from(statement.csv, "utf8");
      const hash = createHash("sha256").update(bytes).digest("hex");
      const storagePath = `${workspaceId}/${hash}.csv`;
      const upload = await db.storage.from("imports").upload(storagePath, bytes, { contentType: "text/csv", upsert: false });
      if (upload.error && !/already exists|duplicate/i.test(upload.error.message)) throw new Error(upload.error.message);
      const inserted = await db.from("imports").insert({ workspace_id: workspaceId, filename: `${account.account_name} bank sync ${today}.csv`, storage_path: storagePath,
        file_hash: hash, status: "queued", mapping: statement.mapping, total_rows: statement.rowCount }).select("id").single();
      let importId = inserted.data?.id as string | undefined;
      if (inserted.error) {
        if (inserted.error.code !== "23505") throw new Error(inserted.error.message);
        // Identical window already imported: a no-op, unless an earlier attempt never ran it.
        const existing = await db.from("imports").select("id, status").eq("workspace_id", workspaceId).eq("file_hash", hash).neq("status", "undone").single();
        if (existing.error) throw new Error(existing.error.message);
        importId = existing.data.status === "queued" ? existing.data.id : undefined;
      }
      if (importId) imports.push({ importId, rowCount: statement.rowCount, uid: account.provider_account_uid, lastBookedOn: statement.lastBookedOn });
    }
    return { imports, observations, error: null, ended: false };
  } catch (error) {
    if (error instanceof EnableBankingError && error.expired) {
      await db.from("bank_connections").update({ status: "expired", last_error: "Bank consent expired; reconnect to keep syncing" }).eq("id", connectionId);
      return { imports, observations, error: null, ended: true };
    }
    // Rate limits (about 4 background fetches a day) and bank errors wait for the next run.
    const message = error instanceof EnableBankingError && error.rateLimited ? "The bank rate limit was reached; the next sync will retry" : String(error instanceof Error ? error.message : error);
    return { imports, observations, error: message.slice(0, 1000), ended: false };
  }
}

async function finishBankSync(connectionId: string, workspaceId: string, imports: BankImport[], observations: BankObservation[], error: string | null, ended: boolean) {
  "use step";
  const db = serviceDb();
  // After the imports, which create a new account; a row going to review can't take the balance with it.
  for (const item of observations) {
    const saved = await db.rpc("record_bank_balance", { p_connection_id: connectionId, p_account_name: item.accountName, p_currency_code: item.currencyCode, p_amount_minor: item.amountMinor, p_as_of: item.asOf, p_balance_type: item.balanceType });
    if (saved.error) throw new Error(saved.error.message);
  }
  let landed = true;
  for (const item of imports) {
    const imported = await db.from("imports").select("status").eq("id", item.importId).eq("workspace_id", workspaceId).single();
    if (imported.error) throw new Error(imported.error.message);
    // Only advance the window once the rows are actually in; a failed import re-fetches next time.
    if (imported.data.status !== "completed") { landed = false; continue; }
    const advanced = await db.from("bank_connection_accounts").update({ last_booked_on: item.lastBookedOn }).eq("connection_id", connectionId).eq("provider_account_uid", item.uid);
    if (advanced.error) throw new Error(advanced.error.message);
  }
  // Consent ended: the reason is already on the connection. A failure never publishes a successful sync.
  if (ended) return;
  const now = new Date().toISOString(), problem = error ?? (landed ? null : "A bank import did not finish, so its rows aren't in your numbers yet. The next sync retries.");
  const done = await db.from("bank_connections").update(problem ? { last_attempted_at: now, last_error: problem, sync_started_at: null } : { last_synced_at: now, last_attempted_at: now, last_error: null }).eq("id", connectionId).eq("workspace_id", workspaceId);
  if (done.error) throw new Error(done.error.message);
}

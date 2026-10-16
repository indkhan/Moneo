"use workflow";

import { createHash } from "node:crypto";
import { EnableBankingError, enableBankingClient, type PsuContext } from "@/lib/bank/enable-banking";
import { bankStatement, preferredBalance } from "@/lib/bank/statement";
import { serviceDb } from "@/lib/bank/server";
import { loadWorkspaceSettings } from "@/lib/settings";
import { importFile } from "@/workflows/import-file";

type BankImport = { importId: string; rowCount: number; uid: string; lastBookedOn: string };

// One sync = one ordinary import per bank account, run through the existing import workflow
// so dedupe (bank id as external_id), review, undo and source history are unchanged.
export async function syncBankConnection(connectionId: string, workspaceId: string, psu?: PsuContext) {
  "use workflow";
  const { imports, error } = await stageBankImports(connectionId, workspaceId, psu);
  for (const item of imports) await importFile(item.importId, workspaceId, item.rowCount, 1);
  await finishBankSync(connectionId, workspaceId, imports, error);
}

function isoDay(date: Date) { return date.toISOString().slice(0, 10); }
function daysBefore(day: string, days: number) { return isoDay(new Date(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000)); }

async function stageBankImports(connectionId: string, workspaceId: string, psu?: PsuContext): Promise<{ imports: BankImport[]; error: string | null }> {
  "use step";
  const db = serviceDb();
  const connection = await db.from("bank_connections").select("status, valid_until").eq("id", connectionId).eq("workspace_id", workspaceId).single();
  if (connection.error) throw new Error(connection.error.message);
  if (connection.data.status !== "active") return { imports: [], error: null };
  if (Date.parse(connection.data.valid_until) <= Date.now()) {
    await db.from("bank_connections").update({ status: "expired", last_error: "Bank consent expired; reconnect to keep syncing" }).eq("id", connectionId);
    return { imports: [], error: null };
  }
  const accounts = await db.from("bank_connection_accounts").select("provider_account_uid, currency_code, account_name, last_booked_on").eq("connection_id", connectionId);
  if (accounts.error) throw new Error(accounts.error.message);
  const settings = await loadWorkspaceSettings(db, workspaceId);
  const client = enableBankingClient();
  const today = isoDay(new Date());
  const imports: BankImport[] = [];
  try {
    for (const account of accounts.data) {
      // Re-fetch a week of overlap: late-booked rows dedupe on the bank id.
      const dateFrom = account.last_booked_on ? daysBefore(account.last_booked_on, 7) : daysBefore(today, 90);
      const closing = preferredBalance(await client.balances(account.provider_account_uid, psu), account.currency_code);
      const transactions = await client.bookedTransactions(account.provider_account_uid, dateFrom, psu);
      const statement = bankStatement(transactions, { accountName: account.account_name, currencyCode: account.currency_code, calendarTimezone: settings.timezone }, closing);
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
    return { imports, error: null };
  } catch (error) {
    if (error instanceof EnableBankingError && error.expired) {
      await db.from("bank_connections").update({ status: "expired", last_error: "Bank consent expired; reconnect to keep syncing" }).eq("id", connectionId);
      return { imports, error: null };
    }
    // Rate limits (about 4 background fetches a day) and bank errors wait for the next run.
    const message = error instanceof EnableBankingError && error.rateLimited ? "The bank rate limit was reached; the next sync will retry" : String(error instanceof Error ? error.message : error);
    return { imports, error: message.slice(0, 1000) };
  }
}

async function finishBankSync(connectionId: string, workspaceId: string, imports: BankImport[], error: string | null) {
  "use step";
  const db = serviceDb();
  for (const item of imports) {
    const imported = await db.from("imports").select("status").eq("id", item.importId).eq("workspace_id", workspaceId).single();
    if (imported.error) throw new Error(imported.error.message);
    // Only advance the window once the rows are actually in; a failed import re-fetches next time.
    if (imported.data.status !== "completed") continue;
    const advanced = await db.from("bank_connection_accounts").update({ last_booked_on: item.lastBookedOn }).eq("connection_id", connectionId).eq("provider_account_uid", item.uid);
    if (advanced.error) throw new Error(advanced.error.message);
  }
  const done = await db.from("bank_connections").update({ last_synced_at: new Date().toISOString(), last_error: error }).eq("id", connectionId).eq("workspace_id", workspaceId);
  if (done.error) throw new Error(done.error.message);
}

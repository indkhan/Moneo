"use workflow";

import { createHash } from "node:crypto";
import { sleep } from "workflow";
import { start } from "workflow/api";
import { EnableBankingError, enableBankingClient, type BankTransaction, type EnableBankingClient, type PsuContext } from "@/lib/bank/enable-banking";
import { bankObservation, bankStatement } from "@/lib/bank/statement";
import { serviceDb } from "@/lib/bank/server";
import { claimBankSync, holdBankSync, releasedLease } from "@/lib/bank/sync-lease";
import { accountDue } from "@/lib/bank/sync-state";
import { loadWorkspaceSettings } from "@/lib/settings";
import { maybeStartFirstReview, startSyncAgentRun } from "@/lib/import/follow-up";
import { importFile } from "@/workflows/import-file";

type BankImport = { importId: string; rowCount: number; uid: string; lastBookedOn: string };
type BankObservation = { accountName: string; currencyCode: string; amountMinor: string; balanceType: string; asOf: string };
type Staged = { imports: BankImport[]; observations: BankObservation[]; fetched: number; failed: number; problem: string | null; ended: boolean; retryAt: string | null };

// Banks share full history only near consent, so a first sync that failed for a passing reason tries again,
// at most 3 times about 20 minutes apart (later when the bank asks for that).
const FIRST_SYNC_RETRIES = 3;
const FIRST_SYNC_RETRY_MS = 20 * 60_000;

// One sync = one ordinary import per bank account, run through the existing import workflow
// so dedupe (bank id as external_id), review, undo and source history are unchanged.
// The trigger took the connection's lease (lib/bank/start-sync.ts); this run gives it back when it finishes.
export async function syncBankConnection(connectionId: string, workspaceId: string, leaseToken: string, psu?: PsuContext) {
  "use workflow";
  const retryAt = await syncAttempt(connectionId, workspaceId, leaseToken, psu, false);
  if (retryAt) await scheduleFirstSyncRetry(connectionId, workspaceId, 1, retryAt);
}

// A separate run, so the trigger that started the first sync isn't kept waiting while this one sleeps.
// The owner may be gone, so no PSU headers: 3 retries stay under the ~4 background fetches a day.
export async function retryFirstBankSync(connectionId: string, workspaceId: string, attempt: number, at: string) {
  "use workflow";
  await sleep(new Date(at));
  const leaseToken = await claimLeaseStep(connectionId, workspaceId);
  // Another sync holds the connection; it fetches the never-synced accounts too.
  if (!leaseToken) return;
  const retryAt = await syncAttempt(connectionId, workspaceId, leaseToken, undefined, true);
  if (retryAt && attempt < FIRST_SYNC_RETRIES) await scheduleFirstSyncRetry(connectionId, workspaceId, attempt + 1, retryAt);
}

async function syncAttempt(connectionId: string, workspaceId: string, leaseToken: string, psu: PsuContext | undefined, firstSyncRetry: boolean) {
  const staged = await stageBankImports(connectionId, workspaceId, leaseToken, psu, firstSyncRetry);
  for (const item of staged.imports) {
    // importFile runs flattened into this run, so a throw from it would end the sync here.
    // The import's stored status is the truth; finishBankSync reads it.
    try { await importFile(item.importId, workspaceId, item.rowCount, 1, false); } catch {}
    await holdLeaseStep(connectionId, leaseToken);
  }
  await finishBankSync(connectionId, workspaceId, leaseToken, staged);
  if (staged.imports.length) {
    // Once every account is in: one agent run sees the whole sync, and the first review starts at most once.
    // Neither is part of the sync; a failure here leaves the rows for the hourly backlog check.
    const importIds = staged.imports.map(item => item.importId);
    try { await startAgentTeamStep(workspaceId, importIds); } catch {}
    try { await firstReviewStep(workspaceId, importIds); } catch {}
  }
  return staged.retryAt;
}

async function claimLeaseStep(connectionId: string, workspaceId: string) {
  "use step";
  return claimBankSync(serviceDb(), connectionId, workspaceId);
}

// Long imports keep the lease. finishBankSync checks it again, so the answer isn't needed here.
async function holdLeaseStep(connectionId: string, leaseToken: string) {
  "use step";
  await holdBankSync(serviceDb(), connectionId, leaseToken);
}

async function scheduleFirstSyncRetry(connectionId: string, workspaceId: string, attempt: number, at: string) {
  "use step";
  await start(retryFirstBankSync, [connectionId, workspaceId, attempt, at]);
}

async function startAgentTeamStep(workspaceId: string, importIds: string[]) {
  "use step";
  await startSyncAgentRun(serviceDb(), workspaceId, importIds);
}

async function firstReviewStep(workspaceId: string, importIds: string[]) {
  "use step";
  await maybeStartFirstReview(serviceDb(), workspaceId, importIds);
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
    if (!(error instanceof EnableBankingError) || error.expired || error.rateLimited || error.status === 401 || error.status === 403 || error.status < 400 || error.status >= 500) throw error;
    return client.bookedTransactions(uid, daysBefore(today, 90), psu);
  }
}

const CONSENT_ENDED = "Bank consent expired; reconnect to keep syncing";
const APP_KEY_PROBLEM = "Enable Banking rejected the App ID or private key. Check them under Import → Connected banks; syncing resumes once they work.";
const APP_KEY_WAIT_MS = 6 * 3_600_000;

// Network trouble, timeouts, rate limits and bank outages pass; a refused request does not.
function transient(error: unknown) {
  return !(error instanceof EnableBankingError) || error.rateLimited || error.status === 0 || error.status === 408 || error.status >= 500;
}

// A 401 without a session code is an ended consent or the app's own credentials (App ID, key, clock).
// Asking Enable Banking about the app tells them apart: refused too means the key needs the owner, not a reconnect.
async function unauthorizedCause(client: EnableBankingClient): Promise<"app" | "consent" | "unknown"> {
  try { await client.application(); return "consent"; } catch (error) {
    return error instanceof EnableBankingError && (error.status === 401 || error.status === 403) ? "app" : "unknown";
  }
}

async function stageBankImports(connectionId: string, workspaceId: string, leaseToken: string, psu: PsuContext | undefined, firstSyncRetry: boolean): Promise<Staged> {
  "use step";
  const db = serviceDb();
  const staged: Staged = { imports: [], observations: [], fetched: 0, failed: 0, problem: null, ended: true, retryAt: null };
  // The lease ran out before this run started: another sync owns the connection now.
  if (!(await holdBankSync(db, connectionId, leaseToken))) return staged;
  const connection = await db.from("bank_connections").select("status, valid_until").eq("id", connectionId).eq("workspace_id", workspaceId).single();
  if (connection.error) throw new Error(connection.error.message);
  if (connection.data.status !== "active") return staged;
  if (Date.parse(connection.data.valid_until) <= Date.now()) {
    await db.from("bank_connections").update({ status: "expired", last_error: CONSENT_ENDED }).eq("id", connectionId);
    return staged;
  }
  staged.ended = false;
  const accounts = await db.from("bank_connection_accounts").select("provider_account_uid, currency_code, account_name, last_booked_on, last_attempted_at, next_allowed_at").eq("connection_id", connectionId);
  if (accounts.error) throw new Error(accounts.error.message);
  const now = Date.now();
  // Each account keeps its own timing. A first-sync retry fetches only accounts whose history never arrived.
  const due = accounts.data.filter(account => firstSyncRetry
    ? !account.last_booked_on && accountDue({ ...account, last_attempted_at: null }, false, now)
    : accountDue(account, !!psu, now));
  if (!due.length) return staged;
  const settings = await loadWorkspaceSettings(db, workspaceId);
  const client = await enableBankingClient();
  const today = isoDay(new Date());
  for (const account of due) {
    const attemptedAt = new Date().toISOString();
    const saveAccount = async (values: Record<string, unknown>) => {
      const saved = await db.from("bank_connection_accounts").update({ last_attempted_at: attemptedAt, ...values })
        .eq("connection_id", connectionId).eq("provider_account_uid", account.provider_account_uid);
      if (saved.error) throw new Error(saved.error.message);
    };
    staged.fetched++;
    try {
      const observation = bankObservation(await client.balances(account.provider_account_uid, psu), account.currency_code, new Date(), settings.timezone);
      if (observation) staged.observations.push({ accountName: account.account_name, currencyCode: account.currency_code, ...observation });
      const transactions = await bookedSince(client, account.provider_account_uid, account.last_booked_on, today, psu);
      const item = await stageImport(db, workspaceId, account, transactions, settings.timezone, today);
      if (item) staged.imports.push(item);
      await saveAccount({ next_allowed_at: null, last_error: null });
    } catch (error) {
      if (error instanceof EnableBankingError && (error.expired || error.status === 401)) {
        const cause = error.expired ? "consent" : await unauthorizedCause(client);
        if (cause === "consent") {
          await db.from("bank_connections").update({ status: "expired", last_error: CONSENT_ENDED }).eq("id", connectionId);
          return { ...staged, ended: true };
        }
        // Every account would be refused the same way; the connection says what to fix. The accounts wait 6 hours
        // (with no account error, so saving new credentials can lift exactly this wait) instead of retrying hourly.
        if (cause === "app") {
          const held = await db.from("bank_connection_accounts").update({ next_allowed_at: new Date(now + APP_KEY_WAIT_MS).toISOString() }).eq("connection_id", connectionId);
          if (held.error) throw new Error(held.error.message);
          return { ...staged, failed: staged.failed + 1, problem: APP_KEY_PROBLEM };
        }
      }
      // This account waits, as long as the bank asked when it said; the others still sync.
      staged.failed++;
      const limited = error instanceof EnableBankingError && error.rateLimited;
      const nextAllowed = now + ((error instanceof EnableBankingError ? error.retryAfter : undefined) ?? (limited ? 3600 : 900)) * 1000;
      const reason = limited ? "The bank rate limit was reached; Moneo retries by itself." : String(error instanceof Error ? error.message : error);
      await saveAccount({ next_allowed_at: new Date(nextAllowed).toISOString(), last_error: reason.slice(0, 1000) });
      if (!account.last_booked_on && transient(error))
        staged.retryAt = new Date(Math.max(nextAllowed, now + FIRST_SYNC_RETRY_MS, staged.retryAt ? Date.parse(staged.retryAt) : 0)).toISOString();
    }
  }
  return staged;
}

async function stageImport(db: ReturnType<typeof serviceDb>, workspaceId: string, account: { provider_account_uid: string; account_name: string; currency_code: string },
  transactions: BankTransaction[], timezone: string, today: string): Promise<BankImport | null> {
  const statement = bankStatement(transactions, { accountName: account.account_name, currencyCode: account.currency_code, calendarTimezone: timezone });
  if (!statement) return null;
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
  return importId ? { importId, rowCount: statement.rowCount, uid: account.provider_account_uid, lastBookedOn: statement.lastBookedOn } : null;
}

async function finishBankSync(connectionId: string, workspaceId: string, leaseToken: string, staged: Staged) {
  "use step";
  const db = serviceDb();
  // A run whose lease ran out may overlap a newer one: it must not move the cursors or publish a result.
  if (!(await holdBankSync(db, connectionId, leaseToken))) return;
  // After the imports, which create a new account; a row going to review can't take the balance with it.
  for (const item of staged.observations) {
    const saved = await db.rpc("record_bank_balance", { p_connection_id: connectionId, p_account_name: item.accountName, p_currency_code: item.currencyCode, p_amount_minor: item.amountMinor, p_as_of: item.asOf, p_balance_type: item.balanceType });
    if (saved.error) throw new Error(saved.error.message);
  }
  let landed = true;
  for (const item of staged.imports) {
    const imported = await db.from("imports").select("status").eq("id", item.importId).eq("workspace_id", workspaceId).single();
    if (imported.error) throw new Error(imported.error.message);
    // Only advance the window once the rows are actually in; a failed import re-fetches next time.
    if (imported.data.status !== "completed") { landed = false; continue; }
    const advanced = await db.from("bank_connection_accounts").update({ last_booked_on: item.lastBookedOn }).eq("connection_id", connectionId).eq("provider_account_uid", item.uid);
    if (advanced.error) throw new Error(advanced.error.message);
  }
  const release = async (values: Record<string, unknown>) => {
    const done = await db.from("bank_connections").update({ ...releasedLease, ...values }).eq("id", connectionId).eq("workspace_id", workspaceId).eq("sync_lease_token", leaseToken);
    if (done.error) throw new Error(done.error.message);
  };
  // Consent ended: the reason is already on the connection.
  if (staged.ended) return release({ sync_started_at: null });
  // The connection's message names each account still waiting, including one whose history never arrived.
  const accounts = await db.from("bank_connection_accounts").select("account_name, last_booked_on, last_error").eq("connection_id", connectionId);
  if (accounts.error) throw new Error(accounts.error.message);
  const problems = [staged.problem, landed ? null : "A bank import did not finish, so its rows aren't in your numbers yet. The next sync retries.",
    ...accounts.data.filter(account => account.last_error).map(account => account.last_booked_on
      ? `${account.account_name}: ${account.last_error}` : `${account.account_name}: its history hasn't been fetched yet. ${account.last_error}`)].filter(Boolean);
  // A failure never publishes a successful sync; neither does a run that had nothing to fetch.
  const now = new Date().toISOString(), succeeded = staged.fetched > 0 && !staged.failed && !staged.problem && landed;
  await release({ last_attempted_at: now, last_error: problems.join(" ").slice(0, 1000) || null, ...(succeeded ? { last_synced_at: now } : { sync_started_at: null }) });
}

import "server-only";
import type { Db } from "@/lib/database";
import { enableBankingConfigured } from "@/lib/bank/enable-banking";
import { BANK_REDIRECT_URL } from "@/lib/bank/return-listener";
import { nextBackgroundSync, syncRunning } from "@/lib/bank/sync-state";
import { syncProblems } from "@/lib/sync-problems";
import { serviceKeyStatus } from "@/lib/service-keys";

type SyncImport = { id: string; status: string; total_rows: number; new_rows: number; matched_rows: number; review_rows: number; rejected_rows: number; created_at: string; mapping: { accountName?: string } | null };

const RECENT_IMPORTS_MS = 3 * 86_400_000;

async function importsSince(db: Db, workspaceId: string, since: string) {
  const { data, error } = await db.from("imports").select("id, status, total_rows, new_rows, matched_rows, review_rows, rejected_rows, created_at, mapping")
    .eq("workspace_id", workspaceId).gte("created_at", since).order("created_at");
  if (error) throw new Error("Connected banks are unavailable");
  return data as SyncImport[];
}

async function connectionRows(db: Db, workspaceId: string) {
  const recentSince = new Date(Date.now() - RECENT_IMPORTS_MS).toISOString();
  const [{ data, error }, recent] = await Promise.all([db.from("bank_connections")
    .select("id, aspsp_name, aspsp_country, status, valid_until, last_synced_at, sync_started_at, last_error, accounts:bank_connection_accounts(provider_account_uid, account_name, currency_code, last_booked_on, last_attempted_at, next_allowed_at, last_error)")
    .eq("workspace_id", workspaceId).in("status", ["active", "expired", "error"]).order("created_at", { ascending: false }), importsSince(db, workspaceId, recentSince)]);
  if (error) throw new Error("Connected banks are unavailable");
  const starts = data.map(connection => connection.sync_started_at).filter((start): start is string => !!start).sort();
  const oldest = starts[0];
  const imports = oldest && Date.parse(oldest) < Date.parse(recentSince) ? await importsSince(db, workspaceId, oldest) : recent;
  const connections = data.map(connection => {
    const names = new Set(connection.accounts.map(account => account.account_name));
    const started = connection.sync_started_at ? Date.parse(connection.sync_started_at) : Infinity;
    const own = imports.filter(item => Date.parse(item.created_at) >= started && names.has(item.mapping?.accountName ?? ""));
    const accounts = connection.accounts.map(({ provider_account_uid, account_name, currency_code, last_booked_on }) => ({ provider_account_uid, account_name, currency_code, last_booked_on }));
    const problem = syncProblems([{ name: connection.aspsp_name, status: connection.status, last_error: connection.last_error,
      historyMissing: connection.accounts.some(account => account.last_error && !account.last_booked_on) }])[0] ?? null;
    return { ...connection, accounts, problem, next_sync_at: connection.status === "active" ? nextBackgroundSync(connection.accounts) : null, sync: { running: syncRunning(connection), imports: own.map(item => ({ id: item.id, status: item.status, total_rows: item.total_rows, new_rows: item.new_rows, matched_rows: item.matched_rows, review_rows: item.review_rows, rejected_rows: item.rejected_rows })) } };
  });
  return connections;
}

export async function loadBankConnections(db: Db, workspaceId: string) {
  const [connections, configured, keys] = await Promise.all([connectionRows(db, workspaceId), enableBankingConfigured(), serviceKeyStatus()]);
  return { configured, credentials: keys.enable_banking_app_id, redirectUrl: BANK_REDIRECT_URL, connections };
}

export type BankConnectionsData = Awaited<ReturnType<typeof loadBankConnections>>;

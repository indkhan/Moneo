import type { SupabaseClient } from "@supabase/supabase-js";

/** Whether a bank connection feeds an account. A sync imports into the account with the bank's name and currency; a revoked connection sends nothing more. */
export async function syncedAccounts(db: SupabaseClient, workspaceId: string) {
  const { data, error } = await db.from("bank_connection_accounts").select("account_name, currency_code, bank_connections!inner(status)").eq("workspace_id", workspaceId).neq("bank_connections.status", "revoked");
  if (error) throw new Error(error.message);
  const keys = new Set((data ?? []).map(row => JSON.stringify([row.account_name, row.currency_code])));
  return (name: string, currency: string) => keys.has(JSON.stringify([name, currency]));
}

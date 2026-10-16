import { createClient } from "@supabase/supabase-js";
import { maskAccountNumber } from "@/lib/csv";
import { enableBankingClient, enableBankingConfigured, type BankAccount, type PsuContext } from "./enable-banking";
import { decryptToken } from "./token-crypto";

// Bank tables are service_role-only for writes and for the encrypted session column.
export function serviceDb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Bank sync service is not configured");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function psuFrom(request: Request): PsuContext {
  return {
    ip: request.headers.get("x-forwarded-for")?.split(",")[0].trim() || request.headers.get("x-real-ip") || "127.0.0.1",
    userAgent: (request.headers.get("user-agent") ?? "Moneo").slice(0, 500),
  };
}

// The Moneo account each bank account imports into: bank name + masked IBAN, so a reconnect
// lands in the same account. Same-named accounts (multi-currency pockets) get the currency appended.
export function bankAccountNames(aspspName: string, accounts: BankAccount[]) {
  const base = accounts.map(account => {
    const label = account.account_id?.iban ? maskAccountNumber(account.account_id.iban) : account.name || account.product || account.currency;
    return `${aspspName} ${label}`.trim();
  });
  return base.map((name, index) => Array.from(base.filter(other => other === name).length > 1 ? `${name} ${accounts[index].currency}` : name).slice(0, 100).join(""));
}

export function consentValidUntil(maximumSeconds: number | null | undefined, now = Date.now()) {
  // ponytail: 90 days when the bank doesn't publish a maximum; most allow 180 (issue #82).
  return new Date(now + (maximumSeconds ?? 90 * 86_400) * 1000);
}

// Before a workspace reset deletes the rows, end each consent at Enable Banking. Best effort:
// a session that can't be revoked here still expires at its valid_until.
export async function revokeBankSessions(workspaceId: string) {
  if (!enableBankingConfigured() || !process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    const { data } = await serviceDb().from("bank_connections").select("id, session_id_encrypted").eq("workspace_id", workspaceId).not("session_id_encrypted", "is", null);
    const client = enableBankingClient();
    await Promise.allSettled((data ?? []).map(async row => client.deleteSession(decryptToken(row.session_id_encrypted, row.id))));
  } catch { /* the reset itself must not depend on the bank */ }
}

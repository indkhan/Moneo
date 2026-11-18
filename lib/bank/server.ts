import "server-only";
import { maskAccountNumber } from "@/lib/import/csv";
import { serviceDb } from "@/lib/service-db";
import { EnableBankingError, enableBankingClient, enableBankingConfigured, type BankAccount, type PsuContext } from "./enable-banking";
import { BANK_REDIRECT_URL } from "./return-listener";
import { decryptToken } from "./token-crypto";
import { hasServiceRoleKey } from "@/lib/env";

export function enableBankingErrorMessage(error: unknown, fallback: string) {
  if (!(error instanceof EnableBankingError)) return fallback;
  if (error.code === "REDIRECT_URI_NOT_ALLOWED") return `Enable Banking rejected the return address. Add ${BANK_REDIRECT_URL} as a Redirect URL in your Enable Banking application, then try again.`;
  if (error.status === 401 || error.status === 403) return "Enable Banking rejected the App ID or private key. Check them under Import → Connected banks, then try again.";
  if (error.rateLimited) return "Enable Banking is limiting requests right now. Try again later.";
  if (error.status >= 500) return "Enable Banking or the bank is not responding. Try again later.";
  return error.code ? `${fallback} (Enable Banking said ${error.code}). Try again.` : fallback;
}

export function psuFrom(request: Request): PsuContext {
  return {
    ip: request.headers.get("x-forwarded-for")?.split(",")[0].trim() || request.headers.get("x-real-ip") || "127.0.0.1",
    userAgent: (request.headers.get("user-agent") ?? "Moneo").slice(0, 500),
  };
}

export function bankAccountNames(aspspName: string, accounts: BankAccount[]) {
  const base = accounts.map(account => {
    const label = account.account_id?.iban ? maskAccountNumber(account.account_id.iban) : account.name || account.product || account.currency;
    return `${aspspName} ${label}`.trim();
  });
  return base.map((name, index) => Array.from(base.filter(other => other === name).length > 1 ? `${name} ${accounts[index].currency}` : name).slice(0, 100).join(""));
}

export function consentValidUntil(maximumSeconds: number | null | undefined, now = Date.now()) {
  return new Date(now + (maximumSeconds ?? 90 * 86_400) * 1000);
}

const sessionsExpireWithTheirConsent = () => undefined;

export async function revokeBankSessions(workspaceId: string) {
  if (!(await enableBankingConfigured()) || !hasServiceRoleKey()) return;
  try {
    const { data } = await serviceDb().from("bank_connections").select("id, session_id_encrypted").eq("workspace_id", workspaceId).not("session_id_encrypted", "is", null);
    const client = await enableBankingClient();
    await Promise.allSettled((data ?? []).map(async row => client.deleteSession(decryptToken(row.session_id_encrypted, row.id))));
  } catch { sessionsExpireWithTheirConsent(); }
}

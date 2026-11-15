import { serviceDb } from "@/lib/bank/server";
import { decryptToken, encryptToken } from "@/lib/bank/token-crypto";
import { getEnv } from "@/lib/env";
import { refreshTokens, scalableMcp, ScalableError, type ScalableMcp, type ScalableTokens } from "./client";

export const scalableRedirectUri = () => new URL("/api/scalable/callback", getEnv().NEXT_PUBLIC_APP_URL).toString();

export function scalableConfigured() {
  return Boolean(process.env.BANK_TOKEN_ENCRYPTION_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export const sealTokens = (tokens: ScalableTokens, connectionId: string) => encryptToken(JSON.stringify(tokens), connectionId);
const openTokens = (sealed: string, connectionId: string) => JSON.parse(decryptToken(sealed, connectionId)) as ScalableTokens;

const CLAIM_RETRIES = 40, CLAIM_WAIT_MS = 500;

export async function withScalable<T>(connectionId: string, workspaceId: string, work: (mcp: ScalableMcp) => Promise<T>, fetcher: typeof fetch = fetch, needsMs = 60_000): Promise<T> {
  const db = serviceDb();
  const read = async () => {
    const row = await db.from("scalable_connections").select("client_id, tokens_encrypted, token_version").eq("id", connectionId)
      .eq("workspace_id", workspaceId).eq("status", "active").single();
    if (row.error || !row.data?.tokens_encrypted) throw new ScalableError("Scalable is not connected", 404);
    return { clientId: row.data.client_id as string, version: row.data.token_version as number, tokens: openTokens(row.data.tokens_encrypted, connectionId) };
  };
  let current = await read();
  for (let attempt = 0; current.tokens.expiresAt - Date.now() < needsMs; attempt++) {
    if (attempt === CLAIM_RETRIES) throw new ScalableError("Another request is still renewing the Scalable login", 503);
    const claim = await db.rpc("claim_scalable_refresh", { p_connection_id: connectionId, p_token_version: current.version });
    if (claim.error) throw new Error(claim.error.message);
    if (claim.data) { current = await renew(current, connectionId, fetcher); break; }
    await new Promise(resolve => setTimeout(resolve, CLAIM_WAIT_MS));
    current = await read();
  }
  const mcp = scalableMcp(current.tokens.accessToken, fetcher);
  try {
    await mcp.connect();
    return await work(mcp);
  } catch (error) {
    if (error instanceof ScalableError && error.expired) return expire(connectionId, current.version, "Scalable rejected the login. Connect again.");
    throw error;
  }
}

async function renew(current: { clientId: string; version: number; tokens: ScalableTokens }, connectionId: string, fetcher: typeof fetch) {
  const db = serviceDb();
  if (!current.tokens.refreshToken) return expire(connectionId, current.version, "The Scalable login ended. Connect again.");
  let fresh: ScalableTokens;
  try { fresh = await refreshTokens({ clientId: current.clientId, refreshToken: current.tokens.refreshToken }, fetcher); } catch (error) {
    if (error instanceof ScalableError && error.expired) return expire(connectionId, current.version, "The Scalable login ended. Connect again.");
    await db.from("scalable_connections").update({ refresh_claimed_until: null }).eq("id", connectionId);
    throw error;
  }
  const saved = await db.from("scalable_connections").update({ tokens_encrypted: sealTokens(fresh, connectionId) }).eq("id", connectionId).eq("status", "active");
  if (saved.error) throw new Error(saved.error.message);
  return { ...current, version: current.version + 1, tokens: fresh };
}

async function expire(connectionId: string, version: number, message: string): Promise<never> {
  const ended = await serviceDb().from("scalable_connections").update({ status: "expired", tokens_encrypted: null, last_error: message }).eq("id", connectionId).eq("token_version", version).select("id");
  if (!ended.error && !ended.data?.length) throw new ScalableError("The Scalable login was renewed while this ran. Try again.", 409);
  throw new ScalableError(message, 401, true);
}

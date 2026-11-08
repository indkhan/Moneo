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

const refreshing = new Map<string, Promise<ScalableTokens>>();

/**
 * Runs `work` with a connected MCP session for an active connection. Refreshes the access token
 * when it is about to expire and stores the rotated tokens first, so a crash never loses them.
 * A rejected refresh marks the connection expired: the owner has to connect again. Long work passes `needsMs`,
 * because a token running out halfway looks the same as an ended login.
 */
export async function withScalable<T>(connectionId: string, workspaceId: string, work: (mcp: ScalableMcp) => Promise<T>, fetcher: typeof fetch = fetch, needsMs = 60_000): Promise<T> {
  const db = serviceDb();
  const row = await db.from("scalable_connections").select("client_id, tokens_encrypted").eq("id", connectionId)
    .eq("workspace_id", workspaceId).eq("status", "active").single();
  if (row.error || !row.data?.tokens_encrypted) throw new ScalableError("Scalable is not connected", 404);
  let tokens = openTokens(row.data.tokens_encrypted, connectionId);
  if (tokens.expiresAt - Date.now() < needsMs) {
    // Chat tools run in parallel; one refresh per connection, so a rotated refresh token is never spent twice.
    const stale = tokens, clientId = row.data.client_id;
    const pending = refreshing.get(connectionId) ?? (async () => {
      if (!stale.refreshToken) return expire(connectionId, "The Scalable login ended. Connect again.");
      let fresh: ScalableTokens;
      try { fresh = await refreshTokens({ clientId, refreshToken: stale.refreshToken }, fetcher); } catch (error) {
        if (error instanceof ScalableError && error.expired) return expire(connectionId, "The Scalable login ended. Connect again.");
        throw error;
      }
      const saved = await db.from("scalable_connections").update({ tokens_encrypted: sealTokens(fresh, connectionId) }).eq("id", connectionId).eq("status", "active");
      if (saved.error) throw new Error(saved.error.message);
      return fresh;
    })().finally(() => refreshing.delete(connectionId));
    refreshing.set(connectionId, pending);
    tokens = await pending;
  }
  const mcp = scalableMcp(tokens.accessToken, fetcher);
  try {
    await mcp.connect();
    return await work(mcp);
  } catch (error) {
    if (error instanceof ScalableError && error.expired) return expire(connectionId, "Scalable rejected the login. Connect again.");
    throw error;
  }
}

async function expire(connectionId: string, message: string): Promise<never> {
  await serviceDb().from("scalable_connections").update({ status: "expired", tokens_encrypted: null, last_error: message }).eq("id", connectionId);
  throw new ScalableError(message, 401, true);
}

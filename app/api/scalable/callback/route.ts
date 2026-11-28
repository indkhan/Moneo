import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { connectionReturn } from "@/lib/desktop-bridge";
import { serviceDb } from "@/lib/service-db";
import { decryptToken } from "@/lib/bank/token-crypto";
import { exchangeCode } from "@/lib/scalable/client";
import { sealTokens } from "@/lib/scalable/server";
import { syncScalable } from "@/lib/scalable/sync";

const syncFailureIsStoredOnTheConnection = () => undefined;

const querySchema = z.object({ state: z.string().uuid(), code: z.string().min(1).max(2000).optional(), error: z.string().max(200).optional() });

export async function GET(request: Request) {
  const back = (result: string) => connectionReturn(request.url, `/money/accounts?scalable=${result}#scalable`);
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return NextResponse.redirect(new URL("/setup", request.url), 303); }
  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return back("invalid");
  const db = serviceDb();
  const workspaceId = context.workspace.id;
  const pending = await db.from("scalable_connections").select("id, client_id, redirect_uri, pkce_verifier_encrypted, created_at")
    .eq("auth_state", query.data.state).eq("workspace_id", workspaceId).eq("status", "pending").maybeSingle();
  if (pending.error || !pending.data?.pkce_verifier_encrypted || Date.now() - Date.parse(pending.data.created_at) > 3_600_000) return back("invalid");
  const connectionId: string = pending.data.id;
  const fail = async (message: string) => {
    await db.from("scalable_connections").update({ status: "error", last_error: message, pkce_verifier_encrypted: null }).eq("id", connectionId).eq("status", "pending");
    return back("error");
  };
  if (!query.data.code || query.data.error) return fail(query.data.error ? `Scalable returned ${query.data.error}` : "Scalable did not return a login code");
  try {
    const tokens = await exchangeCode({ clientId: pending.data.client_id, redirectUri: pending.data.redirect_uri, code: query.data.code,
      verifier: decryptToken(pending.data.pkce_verifier_encrypted, connectionId) });
    const activated = await db.from("scalable_connections").update({ status: "active", tokens_encrypted: sealTokens(tokens, connectionId),
      pkce_verifier_encrypted: null, last_error: null }).eq("id", connectionId).eq("status", "pending").select("id").single();
    if (activated.error) throw activated.error;
    await db.from("scalable_connections").update({ status: "revoked", tokens_encrypted: null }).eq("workspace_id", workspaceId)
      .in("status", ["active", "expired", "error"]).neq("id", connectionId);
    await syncScalable(connectionId, workspaceId).catch(syncFailureIsStoredOnTheConnection);
    return back("connected");
  } catch {
    return fail("The Scalable login could not be completed");
  }
}

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/auth";
import { serviceDb } from "@/lib/bank/server";
import { encryptToken } from "@/lib/bank/token-crypto";
import { authorizeUrl, pkcePair, registerClient } from "@/lib/scalable/client";
import { scalableConfigured, scalableRedirectUri } from "@/lib/scalable/server";

// Starts the Scalable login: register a client for this redirect, keep the PKCE verifier sealed
// on a pending connection, and send the browser to Scalable (login + 2FA in the Scalable app).
export async function POST() {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  if (!scalableConfigured()) return NextResponse.json({ error: "Scalable is not configured" }, { status: 503 });
  try {
    const redirectUri = scalableRedirectUri();
    const clientId = await registerClient(redirectUri);
    const { verifier, challenge } = pkcePair();
    const id = randomUUID();
    const pending = await serviceDb().from("scalable_connections").insert({ id, workspace_id: context.workspace.id, client_id: clientId,
      redirect_uri: redirectUri, pkce_verifier_encrypted: encryptToken(verifier, id) }).select("auth_state").single();
    if (pending.error) throw pending.error;
    return NextResponse.json({ url: authorizeUrl({ clientId, redirectUri, state: pending.data.auth_state, challenge }) });
  } catch {
    return NextResponse.json({ error: "The Scalable connection could not be started" }, { status: 502 });
  }
}

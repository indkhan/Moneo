import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { enableBankingClient } from "@/lib/bank/enable-banking";
import { bankAccountNames, psuFrom, serviceDb } from "@/lib/bank/server";
import { encryptToken } from "@/lib/bank/token-crypto";
import { syncBankConnection } from "@/workflows/bank-sync";

const querySchema = z.object({ state: z.string().uuid(), code: z.string().min(1).max(2000).optional(), error: z.string().max(200).optional() });

// The bank redirects here. The state must match a fresh pending connection in the caller's workspace.
export async function GET(request: Request) {
  const back = (result: string) => NextResponse.redirect(new URL(`/import?bank=${result}`, request.url), 303);
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return NextResponse.redirect(new URL("/login", request.url), 303); }
  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return back("invalid");
  const db = serviceDb();
  const workspaceId = context.workspace.id;
  const pending = await db.from("bank_connections").select("id, aspsp_name, created_at").eq("auth_state", query.data.state)
    .eq("workspace_id", workspaceId).eq("status", "pending").maybeSingle();
  if (pending.error || !pending.data || Date.now() - Date.parse(pending.data.created_at) > 3_600_000) return back("invalid");
  const connectionId: string = pending.data.id;
  const fail = async (message: string) => {
    await db.from("bank_connections").update({ status: "error", last_error: message }).eq("id", connectionId).eq("status", "pending");
    return back("error");
  };
  if (!query.data.code || query.data.error) return fail(query.data.error ? `The bank returned ${query.data.error}` : "The bank did not return a consent code");
  try {
    const psu = psuFrom(request);
    const session = await enableBankingClient().createSession(query.data.code, psu);
    const names = bankAccountNames(pending.data.aspsp_name, session.accounts);
    const linked = await db.from("bank_connection_accounts").insert(session.accounts.map((account, index) => ({
      connection_id: connectionId, workspace_id: workspaceId, provider_account_uid: account.uid,
      iban: account.account_id?.iban?.replace(/\s/g, "") ?? null, currency_code: account.currency, account_name: names[index],
    })));
    if (linked.error) throw linked.error;
    // The status filter makes the state single-use even if the callback is replayed concurrently.
    const activated = await db.from("bank_connections").update({ status: "active", session_id_encrypted: encryptToken(session.session_id, connectionId),
      valid_until: session.access.valid_until, last_error: null }).eq("id", connectionId).eq("status", "pending").select("id").single();
    if (activated.error) throw activated.error;
    // A reconnect supersedes older connections to the same bank; account names match, so imports land in the same accounts.
    await db.from("bank_connections").update({ status: "revoked", session_id_encrypted: null }).eq("workspace_id", workspaceId)
      .eq("aspsp_name", pending.data.aspsp_name).in("status", ["active", "expired", "error"]).neq("id", connectionId);
    await start(syncBankConnection, [connectionId, workspaceId, psu]);
    return back("connected");
  } catch {
    return fail("The bank session could not be created");
  }
}

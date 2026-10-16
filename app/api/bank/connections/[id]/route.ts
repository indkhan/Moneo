import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { enableBankingClient, EnableBankingError } from "@/lib/bank/enable-banking";
import { psuFrom, serviceDb } from "@/lib/bank/server";
import { decryptToken } from "@/lib/bank/token-crypto";

// Disconnect: revoke consent at Enable Banking and forget the session. Imported data stays; undo imports separately.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  const id = z.string().uuid().safeParse((await params).id);
  if (!id.success) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const db = serviceDb();
  const connection = await db.from("bank_connections").select("session_id_encrypted").eq("id", id.data).eq("workspace_id", context.workspace.id).maybeSingle();
  if (connection.error || !connection.data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (connection.data.session_id_encrypted) {
    try {
      await enableBankingClient().deleteSession(decryptToken(connection.data.session_id_encrypted, id.data), psuFrom(request));
    } catch (error) {
      // An already-ended session is fine to forget; anything else keeps the handle so the user can retry.
      if (!(error instanceof EnableBankingError && (error.expired || error.status === 404)))
        return NextResponse.json({ error: "The bank could not be disconnected. Try again." }, { status: 502 });
    }
  }
  const revoked = await db.from("bank_connections").update({ status: "revoked", session_id_encrypted: null }).eq("id", id.data).eq("workspace_id", context.workspace.id);
  if (revoked.error) return NextResponse.json({ error: "The bank could not be disconnected. Try again." }, { status: 500 });
  return NextResponse.json({ status: "revoked" });
}

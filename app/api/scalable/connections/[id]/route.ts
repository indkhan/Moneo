import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { serviceDb } from "@/lib/bank/server";

// Disconnect: forget the tokens. Synced data stays. Scalable access itself is ended under
// Profile → Security → Agentic Investing in Scalable.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  const id = z.string().uuid().safeParse((await params).id);
  if (!id.success) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const revoked = await serviceDb().from("scalable_connections").update({ status: "revoked", tokens_encrypted: null, pkce_verifier_encrypted: null })
    .eq("id", id.data).eq("workspace_id", context.workspace.id).select("id");
  if (revoked.error) return NextResponse.json({ error: "Scalable could not be disconnected. Try again." }, { status: 500 });
  if (!revoked.data.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ status: "revoked" });
}

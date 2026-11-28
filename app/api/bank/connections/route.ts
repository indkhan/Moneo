import { NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/auth";
import { loadBankConnections } from "@/lib/bank/connections";

export async function GET() {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  try { return NextResponse.json(await loadBankConnections(context.supabase, context.workspace.id)); }
  catch { return NextResponse.json({ error: "Connected banks are unavailable" }, { status: 500 }); }
}

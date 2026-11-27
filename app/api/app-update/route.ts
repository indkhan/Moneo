import { NextResponse } from "next/server";
import { availableUpdate } from "@/lib/app-update";
import { requireWorkspace } from "@/lib/auth";

export async function GET() {
  try { await requireWorkspace(); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  return NextResponse.json({ update: await availableUpdate() }, { headers: { "cache-control": "no-store" } });
}

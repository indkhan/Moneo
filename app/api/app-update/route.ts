import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { availableUpdate, UPDATE_CHECKS_COOKIE } from "@/lib/app-update";
import { requireWorkspace } from "@/lib/auth";

export async function GET() {
  try { await requireWorkspace(); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  const enabled = (await cookies()).get(UPDATE_CHECKS_COOKIE)?.value === "1";
  return NextResponse.json({ update: enabled ? await availableUpdate() : null }, { headers: { "cache-control": "no-store" } });
}

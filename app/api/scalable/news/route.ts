import { NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/auth";
import { ScalableError } from "@/lib/scalable/client";
import { activeScalableConnection, investmentsSecurity, securityInput } from "@/lib/scalable/live";
import { withScalable } from "@/lib/scalable/server";

export const maxDuration = 30;

export async function GET(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  const input = securityInput.safeParse({ action: "news", isin: new URL(request.url).searchParams.get("isin") ?? undefined });
  if (!input.success) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const connection = await activeScalableConnection(context.workspace.id);
  if (!connection) return NextResponse.json({ error: "Connect Scalable again to read its news." }, { status: 409 });
  try {
    const news = await withScalable(connection.id, context.workspace.id, mcp => investmentsSecurity(mcp, input.data));
    return NextResponse.json(news, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ScalableError && error.expired) return NextResponse.json({ error: error.message }, { status: 409 });
    return NextResponse.json({ error: "Scalable could not load the news. Try again." }, { status: 502 });
  }
}

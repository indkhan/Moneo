import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { loadHolding } from "@/lib/scalable/holding";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  const id = z.string().uuid().safeParse((await params).id);
  if (!id.success) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const view = await loadHolding(context.supabase, context.workspace, id.data);
    return view ? NextResponse.json(view, { headers: { "Cache-Control": "no-store" } }) : NextResponse.json({ error: "This holding isn't available." }, { status: 404 });
  } catch { return NextResponse.json({ error: "This holding's history could not be loaded." }, { status: 500 }); }
}

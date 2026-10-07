import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { readEvidenceView } from "@/lib/finance/evidence-view";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const { id } = await params;
  const query = new URL(request.url).searchParams;
  const parsed = z.object({ id: z.uuid(), metric: z.string().min(1).max(200).optional(), source: z.string().min(1).max(200).optional() }).safeParse({ id, metric: query.get("metric") ?? undefined, source: query.get("source") ?? undefined });
  if (!parsed.success) return Response.json({ error: "Invalid evidence request" }, { status: 400 });
  try {
    const view = await readEvidenceView(context, id, parsed.data.metric);
    if (!view) return Response.json({ error: "Evidence unavailable" }, { status: 404 });
    if (parsed.data.source) {
      const source = view.supportingRecords.find(record => record.id === parsed.data.source);
      return source ? Response.json({ source, freshness: view.freshness }, { headers: { "Cache-Control": "private, no-store" } }) : Response.json({ error: "Source unavailable" }, { status: 404 });
    }
    return Response.json(view, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: "Evidence unavailable" }, { status: error instanceof Error && /unavailable|disabled|ownership/i.test(error.message) ? 404 : 500 });
  }
}

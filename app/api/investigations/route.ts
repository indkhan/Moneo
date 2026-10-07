import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { evaluateInvestigationScenario, investigationDetail, loadInvestigationEntities, runInvestigation } from "@/lib/finance/investigation-reader";

export async function POST(request: Request) {
  try {
    const context = await requireWorkspace();
    const body = await request.text();
    if (body.length > 65_536) return Response.json({ error: "Investigation request too large" }, { status: 413 });
    const args = z.discriminatedUnion("operation", [
      z.object({ operation: z.literal("query"), query: z.unknown() }).strict(),
      z.object({ operation: z.literal("scenario"), scenario: z.unknown() }).strict(),
      z.object({ operation: z.literal("entities") }).strict(),
      z.object({ operation: z.literal("detail"), detail: z.unknown() }).strict(),
    ]).parse(JSON.parse(body));
    const result = args.operation === "query" ? await runInvestigation(args.query, context) :
      args.operation === "scenario" ? await evaluateInvestigationScenario(args.scenario, context) : args.operation === "detail" ? await investigationDetail(args.detail, context) : await loadInvestigationEntities(context);
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Investigation unavailable";
    const status = message === "Unauthorized" ? 401 : error instanceof z.ZodError || error instanceof SyntaxError || /Unknown|Ambiguous|cursor|changed|exceeds|Resolve/.test(message) ? 400 : 503;
    return Response.json({ error: status === 503 ? "Investigation unavailable; try again" : message }, { status });
  }
}

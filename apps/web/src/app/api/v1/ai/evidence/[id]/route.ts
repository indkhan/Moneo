import { createAiStore } from "@moneo/db";
import { aiRoute, conversationId } from "@/lib/ai-api";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return aiRoute(async (wid) => {
    const { id } = await context.params;
    const result = await createAiStore().evidence(wid, conversationId.parse(id));
    return Response.json(
      result ?? {
        error: "not_found",
        message: "Evidence is unavailable under the current AI data-access policy.",
      },
      { status: result ? 200 : 404, headers: { "cache-control": "no-store" } },
    );
  });
}

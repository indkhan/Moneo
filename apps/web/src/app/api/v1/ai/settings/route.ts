import { createAiStore } from "@moneo/db";
import { aiRoute, readAiBody } from "@/lib/ai-api";
import { publicAiSettings, settingsUpdate } from "@/lib/ai-settings";
import { isAiOwner, requireAiOwner } from "@/lib/ai-admin";
import { loadEnv } from "@moneo/shared/env";
export async function GET() {
  return aiRoute(async (wid, userId) => {
    loadEnv();
    return Response.json(
      { ...(await publicAiSettings(wid)), canManage: await isAiOwner(wid, userId) },
      { headers: { "cache-control": "no-store" } },
    );
  });
}
export async function PATCH(request: Request) {
  return aiRoute(async (wid, userId) => {
    await requireAiOwner(wid, userId);
    const store = createAiStore(),
      cfg = await store.settings(wid);
    try {
      await store.updateSettings(wid, settingsUpdate(await readAiBody(request), cfg.mode));
    } catch (error) {
      return Response.json(
        {
          error: "invalid_settings",
          message:
            error instanceof Error && /read-only|changed/.test(error.message)
              ? error.message
              : "Check AI configuration and account selection.",
        },
        { status: 409 },
      );
    }
    return Response.json(await publicAiSettings(wid));
  });
}

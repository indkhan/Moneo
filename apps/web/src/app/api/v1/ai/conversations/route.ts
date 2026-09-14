import { createAiStore } from "@moneo/db";
import { aiRoute, readAiBody } from "@/lib/ai-api";
import { z } from "zod";
export async function GET() {
  return aiRoute(async (wid) =>
    Response.json(
      { conversations: await createAiStore().listConversations(wid) },
      { headers: { "cache-control": "no-store" } },
    ),
  );
}
export async function POST(request: Request) {
  return aiRoute(async (wid) => {
    const input = z
      .object({ title: z.string().trim().min(1).max(100).optional() })
      .strict()
      .parse(await readAiBody(request));
    return Response.json(
      {
        conversation: await createAiStore().createConversation(
          wid,
          input.title ?? "New conversation",
        ),
      },
      { status: 201 },
    );
  });
}

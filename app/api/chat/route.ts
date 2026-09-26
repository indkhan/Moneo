import { streamText, convertToModelMessages, type UIMessage } from "ai";
import { getModel, SYSTEM_PROMPT } from "@/lib/ai/provider";
import { requireWorkspace } from "@/lib/auth";

export async function POST(req: Request) {
  try {
    await requireWorkspace();
  } catch {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.OPENROUTER_API_KEY) {
    return Response.json(
      { error: "OPENROUTER_API_KEY is missing. Add it to .env (see .env.example)." },
      { status: 400 },
    );
  }
  const { messages }: { messages: UIMessage[] } = await req.json();
  const result = streamText({
    model: getModel(),
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages),
  });
  return result.toUIMessageStreamResponse();
}

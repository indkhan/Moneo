import { StrongAuthError, requireStrongAuth } from "./strong-auth";
import { AiOwnerRequiredError } from "./ai-admin";
import { z } from "zod";
export async function aiRoute(
  action: (workspaceId: string, userId: string) => Promise<Response>,
): Promise<Response> {
  try {
    const { session } = await requireStrongAuth();
    if (!session.wid || !session.uid)
      return Response.json({ error: "unauthorized" }, { status: 401 });
    return await action(session.wid, session.uid);
  } catch (error) {
    if (error instanceof StrongAuthError)
      return Response.json(
        { error: error.code, message: error.message },
        { status: error.code === "SIGNED_OUT" ? 401 : error.code === "DEGRADED" ? 503 : 403 },
      );
    if (error instanceof AiOwnerRequiredError)
      return Response.json({ error: "forbidden", message: error.message }, { status: 403 });
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return Response.json(
        { error: "invalid_request", message: "Check the submitted fields." },
        { status: 400 },
      );
    return Response.json(
      { error: "ai_unavailable", message: "AI is temporarily unavailable. Please retry." },
      { status: 503 },
    );
  }
}
export const conversationId = z.uuid();
export const chatRequest = z
  .object({
    conversationId: conversationId.optional(),
    message: z.string().trim().min(1).max(2000),
    context: z
      .object({
        pathname: z
          .string()
          .regex(/^\/(home|money|plan|ai|settings)(\/[^?#]*)?(\?[^#]*)?$/)
          .max(300),
        label: z.string().max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export async function readAiBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length") ?? 0) > 16384)
    throw new SyntaxError("Request too large");
  const body = await request.text();
  if (Buffer.byteLength(body) > 16384) throw new SyntaxError("Request too large");
  return JSON.parse(body);
}

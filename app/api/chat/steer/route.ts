import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";

const inputSchema = z.object({ steerId: z.uuid(), requestId: z.uuid(), message: z.string().trim().min(1).max(4000) }).strict();

/** Queues a message for the running chat request's next model step; `accepted: false` means the run already ended. */
export async function POST(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid steer" }, { status: 400 });
  const { steerId, requestId, message } = parsed.data;
  const result = await context.supabase.rpc("steer_chat_request", { p_steer_id: steerId, p_request_id: requestId, p_message: message });
  if (result.error) return Response.json({ error: result.error.message }, { status: result.error.code === "P0002" ? 404 : 400 });
  return Response.json({ accepted: result.data === true });
}

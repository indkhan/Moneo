import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { CLIENT_LOG_KINDS } from "@/lib/client-log";
import { jsonBodyOrNull } from "@/lib/json-body";
import { log } from "@/lib/log";

const MAX_BYTES = 32_000;
const reportSchema = z.object({
  kind: z.enum(CLIENT_LOG_KINDS), message: z.string().trim().min(1).max(2000), page: z.string().max(500).optional(),
  details: z.record(z.string().max(100), z.unknown()).optional(),
}).strict();

export async function POST(request: Request) {
  let workspaceId: string;
  try { workspaceId = (await requireWorkspace()).workspace.id; } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  if (Number(request.headers.get("content-length")) > MAX_BYTES) return Response.json({ error: "Report is too large" }, { status: 413 });
  const parsed = reportSchema.safeParse(await jsonBodyOrNull(request));
  if (!parsed.success) return Response.json({ error: "Invalid report" }, { status: 400 });
  const { kind, message, page, details } = parsed.data;
  log({ level: kind === "fetch" ? "warn" : "error", area: "browser", event: `browser.${kind}`, message, details: { page, ...details }, workspaceId });
  return new Response(null, { status: 204 });
}

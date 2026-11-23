import { requireWorkspace } from "@/lib/auth";
import { ATTACHMENT_TYPES, type AttachmentType } from "@/lib/ai/chat-attachments";
import { attachmentSchema } from "@/lib/ai/chat-attachment-schema";
import { citedSection } from "@/lib/ai/documents/read";
import { documentText, isDocument } from "@/lib/ai/documents/store";

export async function GET(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const params = new URL(request.url).searchParams;
  const path = params.get("path") ?? "", location = params.get("location") ?? "";
  if (!attachmentSchema.shape.path.safeParse(path).success || !path.startsWith(`${context.workspace.id}/`) || location.length > 140) return Response.json({ error: "Not found" }, { status: 404 });
  const type = Object.entries(ATTACHMENT_TYPES).find(([, extension]) => path.endsWith(`.${extension}`))![0] as AttachmentType;
  const file = { path, name: "attachment", type };
  if (!isDocument(file)) return Response.json({ error: "Not a document" }, { status: 404 });
  try { return Response.json(citedSection(await documentText(context.supabase, file), location), { headers: { "Cache-Control": "private, no-store" } }); }
  catch { return Response.json({ error: "Not found" }, { status: 404 }); }
}

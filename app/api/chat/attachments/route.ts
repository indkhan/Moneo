import { requireWorkspace } from "@/lib/auth";
import { ATTACHMENT_HINT, ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_LABEL, attachmentSchema } from "@/lib/ai/chat-attachments";
import { sniffType } from "@/lib/ai/documents/sniff";

/** Stores one photo or document for a chat message and returns its reference. */
export async function POST(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return Response.json({ error: "Choose a file" }, { status: 400 });
  if (file.size > MAX_ATTACHMENT_BYTES) return Response.json({ error: `Files must be under ${MAX_ATTACHMENT_LABEL}` }, { status: 413 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = await sniffType(bytes, file.name);
  if (!type) return Response.json({ error: `Attach ${ATTACHMENT_HINT}` }, { status: 415 });
  const path = `${context.workspace.id}/${crypto.randomUUID()}.${ATTACHMENT_TYPES[type]}`;
  const { error } = await context.supabase.storage.from("chat").upload(path, bytes, { contentType: type, upsert: false });
  if (error) return Response.json({ error: error.message }, { status: 400 });
  return Response.json(attachmentSchema.parse({ path, name: file.name.slice(0, 200) || "attachment", type }));
}

/** Serves an attached file; only the owner's workspace folder resolves. It goes through the app because storage is only reachable on the computer running Moneo. */
export async function GET(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const path = new URL(request.url).searchParams.get("path") ?? "";
  if (!attachmentSchema.shape.path.safeParse(path).success || !path.startsWith(`${context.workspace.id}/`)) return Response.json({ error: "Not found" }, { status: 404 });
  const { data, error } = await context.supabase.storage.from("chat").download(path);
  if (error || !data) return Response.json({ error: "Not found" }, { status: 404 });
  // The extension was set from the file's real type on upload.
  const type = Object.entries(ATTACHMENT_TYPES).find(([, extension]) => path.endsWith(`.${extension}`))![0];
  return new Response(data, { headers: { "Content-Type": type, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}

import { requireWorkspace } from "@/lib/auth";
import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES, attachmentSchema, sniffType } from "@/lib/ai/chat-attachments";

/** Stores one photo or PDF for a chat message and returns its reference. */
export async function POST(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return Response.json({ error: "Choose a file" }, { status: 400 });
  if (file.size > MAX_ATTACHMENT_BYTES) return Response.json({ error: "Files must be under 4 MB" }, { status: 413 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffType(bytes);
  if (!type) return Response.json({ error: "Attach a photo (JPEG, PNG, WebP) or a PDF" }, { status: 415 });
  const path = `${context.workspace.id}/${crypto.randomUUID()}.${ATTACHMENT_TYPES[type]}`;
  const { error } = await context.supabase.storage.from("chat").upload(path, bytes, { contentType: type, upsert: false });
  if (error) return Response.json({ error: error.message }, { status: 400 });
  return Response.json(attachmentSchema.parse({ path, name: file.name.slice(0, 200) || "attachment", type }));
}

/** Opens an attached file through a short-lived link; only the owner's workspace folder resolves. */
export async function GET(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const path = new URL(request.url).searchParams.get("path") ?? "";
  if (!attachmentSchema.shape.path.safeParse(path).success || !path.startsWith(`${context.workspace.id}/`)) return Response.json({ error: "Not found" }, { status: 404 });
  const { data, error } = await context.supabase.storage.from("chat").createSignedUrl(path, 300);
  if (error || !data) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.redirect(data.signedUrl, 302);
}

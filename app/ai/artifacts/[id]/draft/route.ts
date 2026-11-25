import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { artifactDraftCsp, artifactPage } from "@/lib/ai/artifact-page";
import { findDraft } from "@/lib/ai/artifact-drafts";
import { requestOrigin } from "@/lib/remote-device";

const querySchema = z.object({ d: z.string().regex(/^[\w-]{10,60}$/), theme: z.enum(["light", "dark"]) });

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return new Response(null, { status: 401 }); }
  const id = z.uuid().safeParse((await params).id);
  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  const draft = id.success && query.success ? findDraft("page", query.data.d, { workspaceId: context.workspace.id, artifactId: id.data }) : null;
  if (!draft || !query.success) return new Response(null, { status: 404 });
  const origin = requestOrigin(request);
  return new Response(artifactPage(draft.html, draft.data, { theme: query.data.theme, origin }), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": artifactDraftCsp(origin), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}

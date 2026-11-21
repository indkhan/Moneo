import { notFound } from "next/navigation";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { findDraft } from "@/lib/ai/artifact-drafts";
import { CARD_SIZES, CARD_SIZE_KEYS } from "@/lib/cards/sizes";
import { CardView } from "@/components/cards/card-view";
import { CHECK_SCOPE } from "@/lib/cards/render";

const querySchema = z.object({ d: z.string().regex(/^[\w-]{10,60}$/), size: z.enum(CARD_SIZE_KEYS), theme: z.enum(["light", "dark"]) });
const CARD_PADDING = 40;

export default async function DraftCardPreview({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { workspace } = await requireWorkspace();
  const id = z.uuid().safeParse((await params).id);
  const query = querySchema.safeParse(await searchParams);
  if (!id.success || !query.success) notFound();
  const draft = findDraft("card", query.data.d, { workspaceId: workspace.id, artifactId: id.data });
  if (!draft) notFound();
  const { size } = query.data;
  return <div className="min-h-screen bg-background text-foreground">
    <div style={{ width: CARD_SIZES[size].width + CARD_PADDING }}>
      <CardView cardId="draft" title={draft.title} size={size} tree={draft.trees[size]} params={draft.params} scope={CHECK_SCOPE} locale={workspace.locale} />
    </div>
  </div>;
}

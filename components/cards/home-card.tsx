import type { requireWorkspace } from "@/lib/auth";
import type { QueryShared } from "@/lib/ai/artifact-data";
import { cardScope, loadCardVersion, renderCard } from "@/lib/cards/render";
import { CARD_HEIGHT, cardSize } from "@/lib/cards/sizes";
import { Skeleton } from "@/components/skeleton";
import { CardView } from "./card-view";

type Context = Awaited<ReturnType<typeof requireWorkspace>>;
export type HomeCardRow = { id: string; title: string; size: string; published_version: number | null };

/** One artifact card rendered on the server: queries, sandbox and checks, then the native card. Streams in on its own. */
export async function HomeCard({ card, context, shared, version, open }: { card: HomeCardRow; context: Context; shared?: QueryShared; version?: number; open?: string }) {
  const shown = version ?? card.published_version;
  const row = shown ? await loadCardVersion(context.supabase, context.workspace.id, card.id, shown) : null;
  const size = cardSize(card.size);
  const rendered = row ? await renderCard(row, context, { size, shared }) : { tree: null, error: "This card has no version yet.", params: [] };
  return <CardView key={`${row?.version}-${size}`} cardId={card.id} title={row?.title ?? card.title} size={size} tree={rendered.tree} error={rendered.error} params={rendered.params} local={rendered.local ?? null}
    scope={cardScope(card.id)} version={version} open={open} locale={context.workspace.locale} />;
}

/** Same size as the card, so nothing moves when it arrives. */
export function CardSkeleton({ title }: { title: string }) {
  return <section aria-label={title} aria-busy="true" className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-5" style={{ height: CARD_HEIGHT }}>
    <p className="truncate text-sm font-medium">{title}</p><Skeleton className="h-9 w-40" /><Skeleton className="min-h-0 flex-1" />
  </section>;
}

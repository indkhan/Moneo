import Link from "next/link";
import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { Check, ChevronLeft, ChevronRight, HousePlus, Maximize2, Minimize2, RefreshCw, X } from "lucide-react";
import { requireWorkspace } from "@/lib/auth";
import { ArtifactFrame } from "@/components/artifact-frame";
import { CardSkeleton, HomeCard } from "@/components/cards/home-card";
import { loadConversation } from "@/lib/ai/conversation-history";
import { BUILTIN_WIDGETS, cardWidgetKey, dashboardItems, dashboardLayoutSchema } from "@/lib/finance/dashboard";
import { CARD_SIZES, CARD_SIZE_KEYS, cardSize } from "@/lib/cards/sizes";
import { publishCard, setCardSize, unpublishCard } from "@/app/dashboard-actions";
import { DeleteArtifactButton } from "../delete-artifact-button";
import { ArtifactChat } from "./artifact-chat";

type Search = { v?: string; full?: string; tab?: string; start?: string; card?: string; cv?: string };
type CardRow = { id: string; title: string; size: string; published_version: number | null; artifact_card_versions: { version: number; title: string }[] };

export default async function ArtifactPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/login"); }
  const { supabase, workspace } = context;
  const [{ id }, search] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [artifact, versions, cards, layout, chat] = await Promise.all([
    supabase.from("artifacts").select("id, title").eq("workspace_id", workspace.id).eq("id", id).is("deleted_at", null).maybeSingle(),
    supabase.from("artifact_versions").select("version, prompt").eq("workspace_id", workspace.id).eq("artifact_id", id).order("version"),
    supabase.from("artifact_cards").select("id, title, size, published_version, artifact_card_versions(version, title)").eq("workspace_id", workspace.id).eq("artifact_id", id).is("deleted_at", null).order("created_at"),
    supabase.from("dashboard_layouts").select("items").eq("workspace_id", workspace.id).maybeSingle(),
    supabase.from("conversations").select("id").eq("workspace_id", workspace.id).eq("artifact_id", id).maybeSingle(),
  ]);
  for (const result of [artifact, versions, cards, layout, chat]) if (result.error) throw result.error;
  if (!artifact.data) notFound();
  // Every artifact has its own chat; one made before chats existed gets it now.
  let conversationId = chat.data?.id as string | undefined;
  if (!conversationId) {
    const created = await supabase.from("conversations").insert({ workspace_id: workspace.id, title: artifact.data.title, artifact_id: id }).select("id").single();
    if (created.error) throw created.error;
    conversationId = created.data.id as string;
  }
  const history = await loadConversation(supabase, workspace.id, conversationId);

  const pages = versions.data ?? [];
  const current = pages.find(item => String(item.version) === search.v) ?? pages.at(-1);
  const latest = pages.at(-1)?.version ?? 0;
  const tab = search.tab === "cards" ? "cards" : "page";
  const at = (query: Partial<Search>) => `/ai/artifacts/${id}?${new URLSearchParams(Object.entries({ tab, ...(current ? { v: String(current.version) } : {}), ...query }).filter((entry): entry is [string, string] => !!entry[1]))}`;
  // The frame reruns the saved queries on every open, so the page always shows today's data.
  const frame = current && <ArtifactFrame src={`/ai/artifacts/${id}/frame?v=${current.version}`} title={artifact.data.title} className="size-full" />;

  if (search.full && frame) return <div className="fixed inset-0 z-50 bg-background">
    {frame}
    <Link href={at({ full: undefined })} aria-label="Exit full screen" className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-lg border border-border bg-card/90 px-3 py-1.5 text-xs shadow hover:bg-muted">
      <Minimize2 className="size-3.5" aria-hidden="true" />Exit</Link>
  </div>;

  const saved = layout.data ? dashboardLayoutSchema.safeParse(layout.data.items) : null;
  const homeItems = dashboardItems(saved?.success ? saved.data : null);
  // Neighbours in the preview are the user's own Home widgets, so the card is seen where it will sit.
  const neighbours = homeItems.filter(key => Object.hasOwn(BUILTIN_WIDGETS, key) && key !== "overview").map(key => BUILTIN_WIDGETS[key as keyof typeof BUILTIN_WIDGETS].split(",")[0]);
  const buildCard = "Create a Home card from this artifact, keeping its purpose, design and live data. Use the existing page and conversation as context. Save it as a draft for me to preview before adding it to Home.";
  const tabLink = (name: "page" | "cards", label: string) => <Link href={at({ tab: name, start: name === "cards" && !cards.data?.length && !history.running ? buildCard : undefined })} aria-current={tab === name ? "page" : undefined}
    className="rounded-md px-3 py-1 text-muted-foreground aria-[current=page]:bg-muted aria-[current=page]:text-foreground">{label}</Link>;

  return <main className="grid gap-4 p-4 lg:h-[calc(100dvh-1rem)] lg:grid-cols-[minmax(300px,400px)_1fr]">
    <aside className="flex min-h-[60dvh] flex-col gap-3 lg:min-h-0">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link href="/ai/artifacts" className="text-xs text-muted-foreground hover:underline">← Artifacts</Link>
          <h1 className="mt-1 truncate font-display text-2xl font-semibold tracking-tight">{artifact.data.title}</h1>
        </div>
        <DeleteArtifactButton id={id} title={artifact.data.title} label="" className="mt-6" />
      </div>
      <ArtifactChat conversationId={conversationId} initial={history.messages} running={history.running ?? null} start={search.start?.slice(0, 4000)} />
    </aside>
    <section aria-label="Artifact" className="flex min-h-[70dvh] flex-col overflow-hidden rounded-xl border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-card px-3 py-1.5 text-xs">
        <nav aria-label="View" className="flex gap-1">{tabLink("page", "Page")}{tabLink("cards", `Home cards${cards.data?.length ? ` · ${cards.data.length}` : ""}`)}</nav>
        {tab === "page" && current && <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
          {current.version > 1 ? <Link href={at({ v: String(current.version - 1) })} aria-label="Previous version" className="rounded p-1 hover:bg-muted"><ChevronLeft className="size-3.5" /></Link> : <span className="p-1 opacity-30"><ChevronLeft className="size-3.5" /></span>}
          v{current.version} of {latest}
          {current.version < latest ? <Link href={at({ v: String(current.version + 1) })} aria-label="Next version" className="rounded p-1 hover:bg-muted"><ChevronRight className="size-3.5" /></Link> : <span className="p-1 opacity-30"><ChevronRight className="size-3.5" /></span>}
          <Link href={at({ full: "1" })} className="ml-2 inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-muted"><Maximize2 className="size-3.5" aria-hidden="true" />Full screen</Link>
        </span>}
      </div>
      {tab === "page" ? <div className="min-h-0 flex-1">{frame ?? <p className="p-6 text-sm text-muted-foreground">The page shows here once it is built. Describe it in the chat.</p>}</div>
        : <div className="min-h-0 flex-1 space-y-8 overflow-y-auto bg-background p-4">
          {!cards.data?.length && <p role="status" className="text-sm text-muted-foreground">{history.running || search.start ? "Building your Home card… Follow the progress in the chat." : "No Home card was created. Click Home cards to build one."}</p>}
          {(cards.data as CardRow[] | null)?.map(card => {
            const all = card.artifact_card_versions.map(item => item.version).sort((a, b) => a - b);
            const newest = all.at(-1) ?? 0;
            const shown = search.card === card.id && all.includes(Number(search.cv)) ? Number(search.cv) : newest;
            const onHome = card.published_version !== null && homeItems.includes(cardWidgetKey(card.id));
            const size = cardSize(card.size);
            const filler = 6 - CARD_SIZES[size].columns;
            const cardAt = (version: number) => at({ card: card.id, cv: String(version) });
            return <article key={card.id} aria-label={card.title} className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{card.artifact_card_versions.find(item => item.version === shown)?.title ?? card.title}</span>
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    {shown > 1 ? <Link href={cardAt(shown - 1)} aria-label="Previous card version" className="rounded p-0.5 hover:bg-muted"><ChevronLeft className="size-3.5" /></Link> : <span className="p-0.5 opacity-30"><ChevronLeft className="size-3.5" /></span>}
                    v{shown} of {newest}
                    {shown < newest ? <Link href={cardAt(shown + 1)} aria-label="Next card version" className="rounded p-0.5 hover:bg-muted"><ChevronRight className="size-3.5" /></Link> : <span className="p-0.5 opacity-30"><ChevronRight className="size-3.5" /></span>}
                  </span>
                  <span className={onHome ? "text-brand" : "text-muted-foreground"}>{onHome ? card.published_version === shown ? "On Home" : `Home shows v${card.published_version}` : "Not on Home"}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span role="group" aria-label="Size" className="inline-flex rounded-lg border border-border p-0.5">{CARD_SIZE_KEYS.map(key => <form key={key} action={setCardSize.bind(null, card.id, key)}>
                    <button type="submit" aria-pressed={size === key} className="rounded-md px-2 py-0.5 font-mono text-[11px] text-muted-foreground aria-pressed:bg-primary aria-pressed:text-primary-foreground">{CARD_SIZES[key].label}</button></form>)}</span>
                  {!onHome || card.published_version !== shown
                    ? <form action={publishCard.bind(null, card.id, shown, card.published_version)}><button type="submit" className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:opacity-90">
                      {onHome ? <><RefreshCw className="size-3.5" aria-hidden="true" />Update on Home</> : <><HousePlus className="size-3.5" aria-hidden="true" />Add to Home</>}</button></form>
                    : <span className="inline-flex items-center gap-1 px-2 text-brand"><Check className="size-3.5" aria-hidden="true" />On Home</span>}
                  {onHome && <form action={unpublishCard.bind(null, card.id)}><button type="submit" className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 hover:bg-muted"><X className="size-3.5" aria-hidden="true" />Remove from Home</button></form>}
                </div>
              </div>
              {/* The card in its Home slot, between the user's own widgets, with live data. */}
              <div className="grid grid-flow-dense gap-3 rounded-2xl border border-dashed border-border p-3 lg:grid-cols-6">
                <div className={`min-w-0 ${CARD_SIZES[size].span}`}>
                  <Suspense fallback={<CardSkeleton title={card.title} />}><HomeCard key={`${shown}-${size}`} card={card} context={context} version={shown} /></Suspense>
                </div>
                {filler > 0 && <div aria-hidden="true" className="hidden gap-3 lg:grid" style={{ gridColumn: `span ${filler}`, gridTemplateColumns: `repeat(${Math.max(1, Math.floor(filler / 2))}, minmax(0, 1fr))` }}>
                  {neighbours.slice(0, Math.max(1, Math.floor(filler / 2))).map(name => <div key={name} className="rounded-2xl border border-border bg-card p-5 opacity-40"><p className="text-sm font-medium">{name}</p></div>)}
                </div>}
              </div>
            </article>;
          })}
        </div>}
    </section>
  </main>;
}

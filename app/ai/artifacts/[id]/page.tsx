import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { Check, ChevronLeft, ChevronRight, Clock, HousePlus, Maximize2, MoreHorizontal, RefreshCw, X } from "lucide-react";
import { requireWorkspace } from "@/lib/auth";
import { ArtifactFrame } from "@/components/artifact-frame";
import { CardSkeleton, HomeCard } from "@/components/cards/home-card";
import { loadConversation } from "@/lib/ai/conversation-history";
import { cardWidgetKey, homeLayout } from "@/lib/finance/dashboard";
import { CARD_SIZES, CARD_SIZE_KEYS, cardSize } from "@/lib/cards/sizes";

import { publishCardSafely, setCardSizeSafely, unpublishCardSafely } from "@/app/dashboard-actions";
import { SafeForm } from "@/components/safe-form";
import { DeleteArtifactButton } from "../delete-artifact-button";
import { ArtifactChat, SendButton } from "./artifact-chat";
import { BarMenu } from "@/components/details-menu";
import { ExitFullScreen, PendingSubmit, RenameArtifact } from "./artifact-controls";

const menuItem = "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-muted aria-[current=true]:font-medium";
const primary = "inline-flex min-h-8 items-center gap-1 rounded-lg bg-primary px-3 py-1 font-medium text-primary-foreground hover:opacity-90";

export const metadata = { title: "Artifact" };

type Search = { v?: string; full?: string; tab?: string; card?: string; cv?: string };
type CardRow = { id: string; title: string; size: string; published_version: number | null; artifact_card_versions: { version: number; title: string }[] };

export default async function ArtifactPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/setup"); }
  const { supabase, workspace } = context;
  const [{ id }, search] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [artifact, versions, cards, layout, chat] = await Promise.all([
    supabase.from("artifacts").select("id, title, first_prompt, first_prompt_claimed_at").eq("workspace_id", workspace.id).eq("id", id).is("deleted_at", null).maybeSingle(),
    supabase.from("artifact_versions").select("version, prompt").eq("workspace_id", workspace.id).eq("artifact_id", id).order("version"),
    supabase.from("artifact_cards").select("id, title, size, published_version, artifact_card_versions(version, title)").eq("workspace_id", workspace.id).eq("artifact_id", id).is("deleted_at", null).order("created_at"),
    supabase.from("dashboard_layouts").select("items").eq("workspace_id", workspace.id).maybeSingle(),
    supabase.from("conversations").select("id").eq("workspace_id", workspace.id).eq("artifact_id", id).maybeSingle(),
  ]);
  for (const result of [artifact, versions, cards, layout, chat]) if (result.error) throw result.error;
  if (!artifact.data) notFound();
  let conversationId = chat.data?.id as string | undefined;
  if (!conversationId) {
    const created = await supabase.from("conversations").insert({ workspace_id: workspace.id, title: artifact.data.title, artifact_id: id }).select("id").single();
    if (created.error) throw created.error;
    conversationId = created.data.id as string;
  }
  const history = await loadConversation(supabase, workspace.id, conversationId);
  const waiting = !history.messages.length && !history.running && !!artifact.data.first_prompt;
  const start = waiting && !artifact.data.first_prompt_claimed_at;
  const retry = waiting && !start ? artifact.data.first_prompt : null;

  const pages = versions.data ?? [];
  const current = pages.find(item => String(item.version) === search.v) ?? pages.at(-1);
  const latest = pages.at(-1)?.version ?? 0;
  const tab = search.tab === "cards" ? "cards" : "page";
  const at = (query: Partial<Search>) => `/ai/artifacts/${id}?${new URLSearchParams(Object.entries({ tab, ...(current ? { v: String(current.version) } : {}), ...query }).filter((entry): entry is [string, string] => !!entry[1]))}`;
  const dataAsOf = new Intl.DateTimeFormat(workspace.locale, { dateStyle: "medium", timeStyle: "short", timeZone: workspace.timezone }).format(new Date());
  const older = !!current && current.version < latest;
  const dataLabel = `${older ? "Older design, current data" : "Data"} as of ${dataAsOf}`;
  const frame = current && <ArtifactFrame src={`/ai/artifacts/${id}/frame?v=${current.version}`} title={artifact.data.title} className="size-full" />;

  if (search.full && frame) return <div className="fixed inset-0 z-50 flex flex-col bg-background">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-card px-3 py-1.5 text-xs">
      <h1 className="min-w-0 flex-1 basis-40 truncate text-sm font-medium">{artifact.data.title}</h1>
      <span>Design v{current.version} of {latest}</span><span className="text-muted-foreground">{dataLabel}</span>
      <ExitFullScreen href={at({ full: undefined })} />
    </div>
    <div className="min-h-0 flex-1">{frame}</div>
  </div>;

  const homeItems = homeLayout(layout.data)?.items ?? [];
  const buildCard = "Make a Home card from this page.";
  const home = Object.fromEntries((cards.data ?? []).map(card => [card.id, homeItems.includes(cardWidgetKey(card.id)) ? card.published_version : null]));
  const tabLink = (name: "page" | "cards", label: string) => <Link href={at({ tab: name })} aria-current={tab === name ? "page" : undefined}
    className="rounded-md px-3 py-1 text-muted-foreground aria-[current=page]:bg-muted aria-[current=page]:text-foreground">{label}</Link>;
  const stepper = (shown: number, newest: number, href: (version: number) => string, label: string, of = "") => <span className="inline-flex items-center text-muted-foreground">
    {shown > 1 ? <Link href={href(shown - 1)} aria-label={`Previous version${of}`} className="rounded p-1.5 hover:bg-muted"><ChevronLeft className="size-3.5" /></Link> : <span className="p-1.5 opacity-30"><ChevronLeft className="size-3.5" /></span>}
    <span className="whitespace-nowrap text-foreground">{label}v{shown} of {newest}</span>
    {shown < newest ? <Link href={href(shown + 1)} aria-label={`Next version${of}`} className="rounded p-1.5 hover:bg-muted"><ChevronRight className="size-3.5" /></Link> : <span className="p-1.5 opacity-30"><ChevronRight className="size-3.5" /></span>}
  </span>;

  const allCards = (cards.data ?? []) as CardRow[];
  const latestTitle = (item: CardRow) => item.artifact_card_versions.reduce((last, next) => next.version > last.version ? next : last, { version: 0, title: item.title }).title;
  const card = allCards.find(item => item.id === search.card) ?? allCards[0];
  const cardView = card && (() => {
    const all = card.artifact_card_versions.map(item => item.version).sort((a, b) => a - b);
    const newest = all.at(-1) ?? 0;
    const shown = search.card === card.id && all.includes(Number(search.cv)) ? Number(search.cv) : newest;
    const onHome = card.published_version !== null && homeItems.includes(cardWidgetKey(card.id));
    const size = cardSize(card.size);
    const name = card.artifact_card_versions.find(item => item.version === shown)?.title ?? card.title;
    const publish = (label: ReactNode) => <SafeForm action={publishCardSafely}><input type="hidden" name="id" value={card.id} /><input type="hidden" name="version" value={shown} /><input type="hidden" name="shown" value={card.published_version ?? ""} /><PendingSubmit className={primary}>{label}</PendingSubmit></SafeForm>;
    const remove = <SafeForm action={unpublishCardSafely}><input type="hidden" name="id" value={card.id} /><PendingSubmit className={menuItem}><X className="size-3.5" aria-hidden="true" />Remove from Home</PendingSubmit></SafeForm>;
    return {
      controls: <>
        {allCards.length > 1
          ? <BarMenu label={`Card: ${name}`} summary={<span className="max-w-40 truncate font-medium">{name}</span>}>
            {allCards.map(item => <Link key={item.id} href={at({ card: item.id })} aria-current={item.id === card.id} className={menuItem}>{latestTitle(item)}</Link>)}
          </BarMenu>
          : <span className="max-w-40 truncate px-1 font-medium">{name}</span>}
        {stepper(shown, newest, version => at({ card: card.id, cv: String(version) }), "", ` of ${card.title}`)}
        <SafeForm action={setCardSizeSafely}><input type="hidden" name="id" value={card.id} />
          <span role="group" aria-label={`Size of ${card.title}. Applies on Home straight away.`} title="Applies on Home straight away" className="inline-flex rounded-lg border border-border p-0.5">{CARD_SIZE_KEYS.map(key =>
            <PendingSubmit key={key} name="size" value={key} aria-pressed={size === key} className="min-h-7 min-w-7 rounded-md px-2 py-0.5 font-mono text-xs text-muted-foreground aria-pressed:bg-primary aria-pressed:text-primary-foreground">{CARD_SIZES[key].label}</PendingSubmit>)}</span></SafeForm>
        {!onHome ? publish(<><HousePlus className="size-3.5" aria-hidden="true" />Add to Home</>)
          : card.published_version !== shown ? <span className="inline-flex items-center gap-0.5">
            {publish(<><RefreshCw className="size-3.5" aria-hidden="true" />Update on Home</>)}
            <BarMenu label="More Home options" summary={<MoreHorizontal className="size-3.5" aria-hidden="true" />}><p className="px-2 py-1.5 text-muted-foreground">Home shows v{card.published_version}</p>{remove}</BarMenu>
          </span>
          : <BarMenu summary={<span className="inline-flex items-center gap-1 font-medium text-brand"><Check className="size-3.5" aria-hidden="true" />On Home</span>}>{remove}</BarMenu>}
      </>,
      preview: <article aria-label={card.title} className="mx-auto min-w-0" style={{ width: `min(100%, ${CARD_SIZES[size].width}px)` }}>
        <Suspense fallback={<CardSkeleton title={card.title} />}><HomeCard key={`${card.id}-${shown}-${size}`} card={card} context={context} version={shown} /></Suspense>
      </article>,
    };
  })();

  return <main className="grid gap-4 p-4 max-lg:h-full max-lg:overflow-y-auto lg:h-full lg:min-h-0 lg:grid-cols-[minmax(300px,400px)_1fr] lg:grid-rows-1 lg:overflow-hidden">
    <aside className="flex min-w-0 flex-col gap-3 max-lg:h-[70dvh] lg:min-h-0">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link href="/ai/artifacts" className="text-xs text-muted-foreground hover:underline">← Artifacts</Link>
          <h1 title={artifact.data.title} className="mt-1 truncate font-display text-2xl font-semibold tracking-tight">{artifact.data.title}</h1>
          <RenameArtifact id={id} title={artifact.data.title} />
        </div>
        <DeleteArtifactButton id={id} title={artifact.data.title} label="" className="mt-6" />
      </div>
      <ArtifactChat conversationId={conversationId} initial={history.messages} messagesCursor={history.messagesCursor} running={history.running ?? null} artifactId={start ? id : undefined} artifact={id} home={home} />
    </aside>
    <section aria-label="Artifact" className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border max-lg:h-[85dvh] lg:min-h-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-card px-3 py-1.5 text-xs">
        <nav aria-label="View" className="flex gap-1">{tabLink("page", "Page")}{tabLink("cards", allCards.length > 1 ? `Home cards · ${allCards.length}` : "Home card")}</nav>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-1.5 gap-y-1">
          {tab === "page" && current && <>
            <span title={dataLabel} className="inline-flex items-center gap-1 px-1 text-muted-foreground"><Clock className="size-3.5" aria-hidden="true" /><span className="sr-only">{dataLabel}</span><span aria-hidden="true" className="max-2xl:hidden">{dataLabel}</span>{older && <span aria-hidden="true" className="2xl:hidden">Older design</span>}</span>
            {stepper(current.version, latest, version => at({ v: String(version) }), "Design ")}
            <Link href={at({ full: "1" })} className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 py-1 hover:bg-muted"><Maximize2 className="size-3.5" aria-hidden="true" />Full screen</Link>
          </>}
          {tab === "cards" && cardView?.controls}
        </div>
      </div>
      {tab === "page" ? <div className="min-h-0 flex-1">{frame ?? <p role="status" className="p-6 text-sm text-muted-foreground">{history.running || start ? "Building your artifact… Follow the progress in the chat." : retry ? <SendButton prompt={retry} idle="Your first request did not finish." label="Send it again" sending="Building your artifact… Follow the progress in the chat." /> : "No page yet. Describe what to build in the chat."}</p>}</div>
        : <div className="min-h-0 flex-1 overflow-y-auto bg-muted/40 p-4 sm:p-8">
          {cardView?.preview ?? (history.running || start ? <p role="status" className="text-sm text-muted-foreground">Follow the progress in the chat.</p> : <SendButton prompt={buildCard} idle="No Home card yet. Moneo can make one from this page, using an AI request." label="Create a Home card" sending="Building your Home card… Follow the progress in the chat." />)}
        </div>}
    </section>
  </main>;
}

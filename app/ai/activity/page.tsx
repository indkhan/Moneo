import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { AutoRefresh } from "@/components/auto-refresh";
import { usageLabel, type ReportedUsage } from "@/lib/ai/usage";
import { answerCardIds } from "@/lib/ai/open-proposals";

export const metadata = { title: "Activity log" };

const FILTERS = { all: "All", attention: "Needs attention", imports: "Imports", analyses: "Reviews", chats: "Chats" } as const;
type Filter = keyof typeof FILTERS;
type Kind = "imports" | "analyses" | "chats";
type Item = { key: string; kind: Kind; at: string; badge: string; title: string; detail: string; href: string; attention: boolean; quiet?: boolean; state: string; action?: string };

const JOB_STATE: Record<string, string> = { queued: "In progress", running: "In progress", completed: "Completed", failed: "Failed", canceled: "Stopped" };
const EMPTY: Record<Exclude<Filter, "all" | "attention">, string> = { imports: "No imports yet.", analyses: "No deep reviews yet.", chats: "No chat activity yet." };
const truncate = (value: string | null | undefined, max = 200) => !value ? "" : value.length > max ? `${value.slice(0, max)}…` : value;

// One feed for Activity and Notifications. Each filter queries only the sources it shows.
export default async function ActivityPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/setup"); }
  const { supabase, workspace } = context;
  const requested = (await searchParams).filter;
  const filter: Filter = requested && requested in FILTERS ? requested as Filter : "all";
  const wants = (kind: Kind) => filter === "all" || filter === "attention" || filter === kind;
  const none = Promise.resolve({ data: null, error: null });
  // Needs attention asks for what is unresolved directly, so older work cannot fall out of a recent sample.
  const attention = filter === "attention";
  const heldCards = attention ? await supabase.from("agent_proposals").select("chat_request_id").eq("workspace_id", workspace.id).in("status", ["proposed", "failed"]).not("chat_request_id", "is", null).order("created_at", { ascending: false }).limit(1000) : { data: [], error: null };
  const heldRequests = [...new Set((heldCards.data ?? []).map(row => row.chat_request_id as string))].slice(0, 100);

  const [imports, jobs, saved, conversations, requests] = await Promise.all([
    wants("imports") ? (query => attention ? query.or("status.eq.failed,review_rows.gt.0,classification_review_rows.gt.0").limit(100) : query.limit(20))(supabase.from("imports").select("id, filename, status, total_rows, new_rows, matched_rows, review_rows, classification_review_rows, rejected_rows, error, created_at")
      .eq("workspace_id", workspace.id).neq("status", "undone").order("created_at", { ascending: false })) : none,
    wants("analyses") ? (query => attention ? query.eq("status", "failed").limit(100) : query.limit(20))(supabase.from("background_jobs").select("id, status, stage, error, created_at, updated_at")
      .eq("workspace_id", workspace.id).eq("kind", "financial_review").order("created_at", { ascending: false })) : none,
    wants("analyses") ? supabase.from("saved_analyses").select("job_id, title").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(20) : none,
    wants("chats") ? supabase.from("conversations").select("id, title, created_at").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(20) : none,
    wants("chats") ? (query => attention ? query.or(`status.eq.failed${heldRequests.length ? `,id.in.(${heldRequests.join(",")})` : ""}`).limit(100) : query.limit(30))(supabase.from("chat_requests").select("id, conversation_id, status, error, usage, answer, updated_at").eq("workspace_id", workspace.id).order("created_at", { ascending: false })) : none,
  ]);
  // A reply whose cards are still open needs attention, so cards from a chat that finished after the user left stay findable.
  const cards = new Map((requests.data ?? []).map(row => [row.id, row.status === "completed" ? answerCardIds(row.answer) : []]));
  const cardIds = [...new Set([...cards.values()].flat())];
  const open = await (cardIds.length ? supabase.from("agent_proposals").select("id, title").eq("workspace_id", workspace.id).in("id", cardIds).in("status", ["proposed", "failed"]) : none);
  const openIds = new Map((open.data ?? []).map(row => [row.id as string, (row as { title?: string }).title ?? ""]));
  const waiting = (id: string) => (cards.get(id) ?? []).filter(card => openIds.has(card)).length;
  // What is waiting, in the words of the first card, so several replies can be told apart.
  const subject = (id: string) => { const first = (cards.get(id) ?? []).map(card => openIds.get(card)).find(Boolean); return first ? truncate(first, 120) : null; };
  const errors = [heldCards, imports, jobs, saved, conversations, requests, open].map(result => result.error).filter(Boolean);
  const titles = new Map((saved.data ?? []).map(row => [row.job_id, row.title]));

  const items: Item[] = [
    ...(imports.data ?? []).map(row => {
      const review = row.review_rows + (row.classification_review_rows ?? 0);
      return { key: `import:${row.id}`, kind: "imports" as const, at: row.created_at, badge: "Import", title: row.filename,
        detail: row.status === "failed" ? truncate(row.error) || "Failed" : `${row.new_rows} new · ${row.matched_rows} matched · ${review} to review · ${row.rejected_rows} rejected · ${row.total_rows} total`,
        href: review > 0 ? `/import/${row.id}/review` : "/import", attention: row.status === "failed" || (row.status === "completed" && review > 0),
        state: row.status === "failed" ? "Failed" : review > 0 ? "Ready to review" : row.status === "completed" ? "Completed" : "In progress", action: row.status === "failed" ? "Open imports" : review > 0 ? `Review ${review} ${review === 1 ? "item" : "items"}` : "View imports" };
    }),
    ...(jobs.data ?? []).map(row => ({ key: `analysis:${row.id}`, kind: "analyses" as const, at: row.updated_at ?? row.created_at, badge: "Review",
      title: titles.get(row.id) ?? "Financial review", detail: row.status === "failed" ? "This review stopped before finishing." : "",
      href: `/ai/activity/${row.id}`, attention: row.status === "failed", state: JOB_STATE[row.status] ?? "In progress", action: row.status === "completed" ? "Open review" : row.status === "failed" ? "See next steps" : "View progress" })),
    ...(conversations.data ?? []).map(row => ({ key: `conversation:${row.id}`, kind: "chats" as const, at: row.created_at, badge: "Conversation", title: row.title,
      detail: "", href: `/ai?conversation=${row.id}`, attention: false, quiet: true, state: "Chat", action: "Open chat" })),
    // Chat rows and successful replies are noise in the combined feed unless cards they raised are still waiting; the rest stay under Chats.
    ...(requests.data ?? []).map(row => ({ key: `chat:${row.id}`, kind: "chats" as const, at: row.updated_at, badge: "Chat",
      title: waiting(row.id) ? subject(row.id) ?? `Chat reply · ${waiting(row.id)} ${waiting(row.id) === 1 ? "card" : "cards"} waiting for you` : `Chat reply ${row.status}`,
      // Model and token details belong to the Chats history, not to a row asking for a decision.
      detail: row.status === "failed" ? "This reply failed. Open the chat to send it again." : waiting(row.id) ? `${waiting(row.id)} ${waiting(row.id) === 1 ? "card" : "cards"} waiting for your decision` : filter === "chats" && row.usage ? usageLabel(row.usage as ReportedUsage) : "",
      state: row.status === "failed" ? "Failed" : waiting(row.id) ? "Ready to review" : row.status === "completed" ? "Completed" : "In progress", action: waiting(row.id) ? "Review in chat" : "Open chat",
      href: `/ai?conversation=${row.conversation_id}`, attention: row.status === "failed" || waiting(row.id) > 0, quiet: row.status !== "failed" && !waiting(row.id) })),
  ];
  const matching = items.filter(item => filter === "attention" ? item.attention : filter === "all" ? !item.quiet : item.kind === filter).sort((a, b) => b.at.localeCompare(a.at));
  const visible = attention ? matching : matching.slice(0, 50);
  const day = (iso: string) => new Date(iso).toLocaleDateString(workspace.locale, { timeZone: workspace.timezone, dateStyle: "medium" });
  const groups = visible.reduce((map, item) => map.set(day(item.at), [...(map.get(day(item.at)) ?? []), item]), new Map<string, Item[]>());

  return <main className="mx-auto w-full max-w-[1400px] space-y-6 px-4 py-6 sm:px-8 lg:py-8">
    <header className="flex flex-col gap-1">
      <p className="eyebrow">{attention ? "Activity log" : "Imports · reviews · chats"}</p>
      <h1 className="page-title">{attention ? "Needs attention" : "Activity log"}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{attention ? "Failures and decisions waiting for you. An item leaves this list once it is resolved, not when you open it." : "Imports, reviews and chats in one feed. Failures and rows waiting for you are under Needs attention."}</p>
    </header>
    <nav aria-label="Activity filters" className="flex flex-wrap gap-2 max-lg:flex-nowrap max-lg:overflow-x-auto [&>*]:shrink-0">{Object.entries(FILTERS).map(([key, label]) =>
      <Link key={key} href={key === "all" ? "/ai/activity" : `/ai/activity?filter=${key}`} aria-current={filter === key ? "page" : undefined}
        className={`inline-flex items-center rounded-full border px-3.5 py-1.5 text-sm max-lg:min-h-9 ${filter === key ? "border-brand bg-brand text-white" : "border-border bg-card hover:bg-muted"}`}>{label}</Link>)}</nav>
    {errors.length > 0 && <p role="alert" className="rounded-xl border border-border bg-card p-4 text-sm text-danger">Could not load part of this activity, so it may be incomplete. <Link className="underline" href={filter === "all" ? "/ai/activity" : `/ai/activity?filter=${filter}`}>Try again</Link></p>}
    {jobs.data?.some(row => row.status === "queued" || row.status === "running") && <AutoRefresh />}
    {attention && (imports.data?.length === 100 || jobs.data?.length === 100 || requests.data?.length === 100) && <p className="text-xs text-muted-foreground">Showing the latest 100 of each kind. Resolve these to see older ones.</p>}
    {!attention && (matching.length > 50 || (imports.data?.length === 20 || jobs.data?.length === 20 || conversations.data?.length === 20)) && <p className="text-xs text-muted-foreground">Showing recent activity only. Everything unresolved is under <Link className="underline" href="/ai/activity?filter=attention">Needs attention</Link>.</p>}
    {!errors.length && !visible.length && <p className="text-muted-foreground">{filter === "attention" ? "Nothing needs your attention." : filter !== "all" ? <>{EMPTY[filter]} <Link className="underline" href="/ai/activity">See all activity</Link></> : <>No activity yet. <Link className="underline" href="/import">Import a statement</Link> or run a review from <Link className="underline" href="/ai">AI</Link>.</>}</p>}
    {[...groups].map(([label, entries]) => <section key={label} aria-label={label} className="space-y-2">
      <h2 className="eyebrow">{label}</h2>
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">{entries.map(item =>
        <li key={item.key}><Link href={item.href} className="flex items-start gap-3 px-5 py-4 hover:bg-muted/50">
          <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${item.attention ? "bg-warning" : "bg-border"}`} />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-baseline justify-between gap-x-3"><span className="line-clamp-2 min-w-0 font-medium">{item.title}</span>
              <span className="text-xs text-muted-foreground">{item.state} · {item.badge} · {new Date(item.at).toLocaleTimeString(workspace.locale, { timeZone: workspace.timezone, timeStyle: "short" })}</span></span>
            {item.detail && <span className="mt-0.5 block text-sm text-muted-foreground">{item.detail}</span>}
            {item.action && <span className="mt-1 block text-xs underline">{item.action}</span>}
          </span>
        </Link></li>)}</ul>
    </section>)}
  </main>;
}

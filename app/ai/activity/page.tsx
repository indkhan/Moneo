import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { usageLabel, type ReportedUsage } from "@/lib/ai/usage";

const FILTERS = { all: "All", attention: "Needs attention", imports: "Imports", analyses: "Analyses", tools: "Tools", chats: "Chats" } as const;
type Filter = keyof typeof FILTERS;
type Kind = "imports" | "analyses" | "tools" | "chats";
type Item = { key: string; kind: Kind; at: string; badge: string; title: string; detail: string; href: string; attention: boolean; quiet?: boolean };

const words = (value: string) => { const text = value.replaceAll("_", " "); return text[0].toUpperCase() + text.slice(1); };
const truncate = (value: string | null | undefined, max = 200) => !value ? "" : value.length > max ? `${value.slice(0, max)}…` : value;

// One feed for Activity and Notifications. Each filter queries only the sources it shows.
export default async function ActivityPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/login"); }
  const { supabase, workspace } = context;
  const requested = (await searchParams).filter;
  const filter: Filter = requested && requested in FILTERS ? requested as Filter : "all";
  const wants = (kind: Kind) => filter === "all" || filter === "attention" || filter === kind;
  const none = Promise.resolve({ data: null, error: null });

  const [imports, jobs, saved, artifacts, versions, conversations, requests, generations] = await Promise.all([
    wants("imports") ? supabase.from("imports").select("id, filename, status, total_rows, new_rows, matched_rows, review_rows, classification_review_rows, rejected_rows, error, created_at")
      .eq("workspace_id", workspace.id).neq("status", "undone").order("created_at", { ascending: false }).limit(20) : none,
    wants("analyses") ? supabase.from("background_jobs").select("id, status, stage, error, created_at, updated_at")
      .eq("workspace_id", workspace.id).eq("kind", "financial_review").order("created_at", { ascending: false }).limit(20) : none,
    wants("analyses") ? supabase.from("saved_analyses").select("job_id, title").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(20) : none,
    wants("tools") ? supabase.from("artifacts").select("id, kind, name, created_at").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(20) : none,
    wants("tools") ? supabase.from("artifact_versions").select("artifact_id, version, status").eq("workspace_id", workspace.id).eq("status", "validated").order("created_at", { ascending: false }).limit(50) : none,
    wants("chats") ? supabase.from("conversations").select("id, title, created_at").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(20) : none,
    wants("chats") ? supabase.from("chat_requests").select("id, conversation_id, status, error, usage, updated_at").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(30) : none,
    wants("tools") ? supabase.from("artifact_generation_requests").select("id, purpose, description, status, error, usage, updated_at").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(30) : none,
  ]);
  const errors = [imports, jobs, saved, artifacts, versions, conversations, requests, generations].map(result => result.error).filter(Boolean);
  const titles = new Map((saved.data ?? []).map(row => [row.job_id, row.title]));
  const latestVersion = new Map<string, number>();
  for (const row of versions.data ?? []) latestVersion.set(row.artifact_id, Math.max(row.version, latestVersion.get(row.artifact_id) ?? 0));

  const items: Item[] = [
    ...(imports.data ?? []).map(row => {
      const review = row.review_rows + (row.classification_review_rows ?? 0);
      return { key: `import:${row.id}`, kind: "imports" as const, at: row.created_at, badge: "Import", title: `${row.filename} · ${row.status}`,
        detail: row.status === "failed" ? truncate(row.error) || "Failed" : `${row.new_rows} new · ${row.matched_rows} matched · ${row.review_rows} for review · ${row.rejected_rows} rejected · ${row.total_rows} total`,
        href: review > 0 ? `/import/${row.id}/review` : "/import", attention: row.status === "failed" || (row.status === "completed" && review > 0) };
    }),
    ...(jobs.data ?? []).map(row => ({ key: `analysis:${row.id}`, kind: "analyses" as const, at: row.updated_at ?? row.created_at, badge: "Analysis",
      title: titles.get(row.id) ?? "Deep Analysis", detail: row.status === "failed" ? truncate(row.error) || "Failed" : row.status === "completed" ? "Completed" : words(row.stage),
      href: `/ai/activity/${row.id}`, attention: row.status === "failed" })),
    ...(artifacts.data ?? []).map(row => ({ key: `artifact:${row.id}`, kind: "tools" as const, at: row.created_at, badge: "Saved tool", title: row.name,
      detail: `${row.kind.replaceAll("_", " ")}${latestVersion.get(row.id) ? ` v${latestVersion.get(row.id)}` : ""}`, href: `/ai/library/${row.id}`, attention: false })),
    ...(generations.data ?? []).map(row => ({ key: `generation:${row.id}`, kind: "tools" as const, at: row.updated_at, badge: "Generation",
      title: `${row.purpose === "calculator" ? "Calculator draft" : "Tool proposal"} ${row.status}`,
      detail: [truncate(row.description, 120), row.usage ? usageLabel(row.usage as ReportedUsage) : "", row.status === "failed" ? truncate(row.error) : ""].filter(Boolean).join(" · "),
      href: `/ai/activity/generation/${row.id}`, attention: row.status === "failed" })),
    ...(conversations.data ?? []).map(row => ({ key: `conversation:${row.id}`, kind: "chats" as const, at: row.created_at, badge: "Conversation", title: row.title,
      detail: "AI chat thread", href: `/ai?conversation=${row.id}`, attention: false })),
    // Successful replies are noise in the combined feed; they stay under Chats.
    ...(requests.data ?? []).map(row => ({ key: `chat:${row.id}`, kind: "chats" as const, at: row.updated_at, badge: "Chat", title: `Chat reply ${row.status}`,
      detail: [row.usage ? usageLabel(row.usage as ReportedUsage) : "", row.status === "failed" ? truncate(row.error) : ""].filter(Boolean).join(" · ") || words(row.status),
      href: `/ai?conversation=${row.conversation_id}`, attention: row.status === "failed", quiet: row.status !== "failed" })),
  ];
  const visible = items.filter(item => filter === "attention" ? item.attention : filter === "all" ? !item.quiet : item.kind === filter)
    .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50);
  const day = (iso: string) => new Date(iso).toLocaleDateString(workspace.locale, { timeZone: workspace.timezone, dateStyle: "medium" });
  const groups = visible.reduce((map, item) => map.set(day(item.at), [...(map.get(day(item.at)) ?? []), item]), new Map<string, Item[]>());

  return <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8 sm:px-8 lg:py-10">
    <header>
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Activity</h1>
      <p className="mt-2 text-sm text-muted-foreground">Imports, analyses, saved tools and chats in one feed. Failures and rows waiting for you are under Needs attention.</p>
    </header>
    <nav aria-label="Activity filters" className="flex flex-wrap gap-2">{Object.entries(FILTERS).map(([key, label]) =>
      <Link key={key} href={key === "all" ? "/ai/activity" : `/ai/activity?filter=${key}`} aria-current={filter === key ? "page" : undefined}
        className={`rounded-full border px-3 py-1.5 text-sm ${filter === key ? "border-brand bg-brand text-white" : "border-border bg-card hover:bg-muted"}`}>{label}</Link>)}</nav>
    {errors.length > 0 && <p role="alert" className="rounded-xl border border-border bg-card p-4 text-sm text-red-700 dark:text-red-300">Could not load part of this activity: {truncate(errors[0]?.message ?? "Unavailable")}</p>}
    {!errors.length && !visible.length && <p className="text-muted-foreground">{filter === "attention" ? "Nothing needs your attention." : <>No activity yet. <Link className="underline" href="/import">Import a statement</Link> or run a review from <Link className="underline" href="/ai">AI</Link>.</>}</p>}
    {[...groups].map(([label, entries]) => <section key={label} aria-label={label} className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</h2>
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">{entries.map(item =>
        <li key={item.key}><Link href={item.href} className="flex items-start gap-3 px-5 py-4 hover:bg-muted/50">
          <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${item.attention ? "bg-amber-500" : "bg-border"}`} />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-baseline justify-between gap-x-3"><span className="truncate font-medium">{item.title}</span>
              <span className="text-xs text-muted-foreground">{item.badge} · {new Date(item.at).toLocaleTimeString(workspace.locale, { timeZone: workspace.timezone, timeStyle: "short" })}</span></span>
            {item.detail && <span className="mt-0.5 block text-sm text-muted-foreground">{item.detail}</span>}
          </span>
        </Link></li>)}</ul>
    </section>)}
  </main>;
}

import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { MEMORY_COLUMNS, isCurrent, trueUntil, type MemoryRow } from "@/lib/ai/memory";
import { MEMORY_KINDS, MEMORY_KIND_LABELS, type MemoryKind } from "@/lib/ai/memory-note";
import { calendarDate } from "@/lib/finance/calendar";
import { loadMemory, loadNames, type MemoryEntry } from "@/lib/organize/surfaces";
import { Change, MemoryItem, Suggested, type Dates } from "./memory-item";

export const metadata = { title: "What Moneo knows about you" };

const SECTIONS: { kind: MemoryKind; title: string; empty: string }[] = [
  { kind: "pledge", title: "Pledges", empty: "Promises you make about your money, like cutting out a payee or capping a category." },
  { kind: "plan", title: "Plans", empty: "Things you expect to happen, like a move, a big purchase or a price rise." },
  { kind: "fact", title: "Facts", empty: "Background about your life that explains your money." },
  { kind: "explanation", title: "Explanations", empty: "Why a payment, payee or transfer is what it is." },
  { kind: "preference", title: "Preferences", empty: "How you want Moneo to talk to you." },
];

export default async function MemoryPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/setup"); }
  const { supabase, workspace, settings } = context;
  const view = (await searchParams).view === "history" ? "history" : "now";
  const today = calendarDate(new Date(), settings.timezone);
  const day = (value: string) => new Intl.DateTimeFormat(workspace.locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
  const until = (row: MemoryRow) => { const last = trueUntil(row); return last ? day(last) : null; };
  const dates = (row: MemoryRow): Dates => ({
    from: row.valid_from && day(row.valid_from), until: until(row),
    said: day(calendarDate(row.created_at, settings.timezone)), changed: row.closed_at && day(calendarDate(row.closed_at, settings.timezone)),
  });
  const loaded = await supabase.from("memories").select(MEMORY_COLUMNS).eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(1000);
  const tabs = <nav aria-label="Memory views" className="flex gap-1.5">
    {(["now", "history"] as const).map(item => <Link key={item} href={item === "now" ? "/ai/memory" : "/ai/memory?view=history"} aria-current={view === item ? "page" : undefined}
      className={`inline-flex h-11 items-center rounded-full border px-3.5 text-[13px] lg:h-9 ${view === item ? "border-foreground bg-foreground text-background" : "border-input text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
      {item === "now" ? "What's true now" : "History"}</Link>)}
  </nav>;
  const rows = (loaded.data ?? []) as MemoryRow[];
  return <main className="mx-auto w-full max-w-3xl space-y-5 px-4 py-6 text-foreground sm:px-8 lg:py-8">
    <header>
      <p className="eyebrow">AI</p>
      <h1 className="mt-1 page-title">What Moneo knows about you</h1>
      <p className="mt-2 text-sm text-muted-foreground">What you told Moneo in chat and calls about yourself. It uses this in later answers and keeps what changed, so you can see what you used to think. Edit, end or forget anything.</p>
    </header>
    {!settings.ai_memory && <p role="status" className="rounded-xl border border-border bg-card p-4 text-sm">Memory is off: nothing new is saved and nothing here is used. <Link href="/settings#ai" className="underline">Turn it on in Settings</Link></p>}
    {tabs}
    {loaded.error ? <p role="alert" className="text-sm">Could not load your memories. <Link href="/ai/memory" className="underline">Try again</Link></p>
      : view === "now" ? <Now rows={rows} today={today} dates={dates} payees={await loadPayees(supabase, workspace.id)} />
      : <History rows={rows} today={today} dates={dates} />}
  </main>;
}

async function loadPayees(db: Awaited<ReturnType<typeof requireWorkspace>>["supabase"], workspaceId: string) {
  const [entries, names] = await Promise.all([loadMemory(db, workspaceId), loadNames(db, workspaceId)]);
  return entries.map((entry: MemoryEntry) => ({ id: entry.id, name: entry.identityName,
    summary: [entry.categoryId && names.categories.get(entry.categoryId), entry.merchantId && names.merchants.get(entry.merchantId), entry.purpose].filter(Boolean).join(" · ") }));
}

function Now({ rows, today, dates, payees }: { rows: MemoryRow[]; today: string; dates: (row: MemoryRow) => Dates; payees: { id: string; name: string; summary: string }[] }) {
  const suggested = rows.filter(row => row.status === "suggested");
  const current = rows.filter(row => isCurrent(row, today));
  const ofKind = (kind: MemoryKind) => current.filter(row => row.kind === kind)
    .sort((a, b) => kind === "plan" ? (a.valid_from ?? "9999").localeCompare(b.valid_from ?? "9999") : 0);
  return <div className="space-y-6">
    {suggested.length > 0 && <section aria-labelledby="suggested" className="space-y-2">
      <h2 id="suggested" className="text-sm font-medium">Waiting for you</h2>
      <ul className="space-y-2">{suggested.map(row => <Suggested key={row.id} row={row} dates={dates(row)} />)}</ul>
    </section>}
    {SECTIONS.map(section => {
      const items = ofKind(section.kind);
      const payeeNotes = section.kind === "explanation" ? payees : [];
      return <section key={section.kind} aria-labelledby={`memory-${section.kind}`} className="space-y-2">
        <h2 id={`memory-${section.kind}`} className="text-sm font-medium">{section.title}{items.length + payeeNotes.length > 0 && <span className="text-muted-foreground"> · {items.length + payeeNotes.length}</span>}</h2>
        {items.length + payeeNotes.length === 0 ? <p className="text-sm text-muted-foreground">{section.empty}</p>
          : <ul className="space-y-2">
            {items.map(row => <MemoryItem key={row.id} row={row} dates={dates(row)} kinds={MEMORY_KINDS.map(kind => [kind, MEMORY_KIND_LABELS[kind]])} />)}
            {payeeNotes.map(payee => <li key={payee.id} className="rounded-xl border border-border bg-card p-4 text-sm">
              <p><span className="font-medium">{payee.name}</span>{payee.summary && <span className="text-muted-foreground"> · {payee.summary}</span>}</p>
              <p className="mt-1 text-xs text-muted-foreground">What you told the organizer about this payee. <Link href="/money/organize?tab=memory" className="underline">Edit in AI organizer</Link></p>
            </li>)}
          </ul>}
      </section>;
    })}
  </div>;
}

function History({ rows, today, dates }: { rows: MemoryRow[]; today: string; dates: (row: MemoryRow) => Dates }) {
  const successor = new Map(rows.filter(row => row.replaces && row.status !== "suggested").map(row => [row.replaces, row]));
  const changes = rows.filter(row => row.status === "replaced" || row.status === "ended" || (row.status === "active" && !isCurrent(row, today)))
    .sort((a, b) => (b.closed_at ?? b.valid_until ?? "").localeCompare(a.closed_at ?? a.valid_until ?? ""));
  if (!changes.length) return <p className="text-sm text-muted-foreground">Nothing has changed yet. When you tell Moneo something new that replaces what it knew, or that something is no longer true, the earlier version is kept here.</p>;
  return <ul aria-label="Changes" className="space-y-3">{changes.map(row => {
    const next = successor.get(row.id);
    return <Change key={row.id} before={row} beforeDates={dates(row)} after={next ?? null} afterDates={next ? dates(next) : null} />;
  })}</ul>;
}

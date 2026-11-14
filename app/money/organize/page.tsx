import type { SupabaseClient } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { SOURCES, type Source, countNeedsYou, loadAiCreated, loadDecisions, loadMemory, loadNames, loadOpenQuestions, loadRecentAnswers, loadRunGroups } from "@/lib/organize/surfaces";
import { Decided } from "./decided";
import { Memory } from "./memory";
import { NeedsYou } from "./needs-you";
import { Chips, Notice } from "./parts";

export const metadata = { title: "AI organizer" };

const TABS = ["needs", "decided", "memory"] as const;
const count = (value: string | string[] | undefined) => { const parsed = z.coerce.number().int().min(0).max(100000).safeParse(Array.isArray(value) ? value[0] : value); return parsed.success && value !== undefined ? parsed.data : null; };
const plural = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;

export default async function OrganizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/setup"); }
  const { supabase, workspace } = context;
  const params = await searchParams;
  const tab = TABS.find(item => item === params.tab) ?? "needs";
  const source = SOURCES.find(item => item === params.source);
  const page = count(params.page) ?? 0;
  const [names, needs] = await Promise.all([loadNames(supabase, workspace.id), countNeedsYou(supabase, workspace.id)]);
  const flash = { labelled: count(params.labelled), undone: count(params.undone), skipped: count(params.skipped), confirmed: count(params.confirmed),
    answer: count(params.undoneAnswer), saved: count(params.saved), removed: count(params.removed) };
  const message = flash.labelled !== null ? `Labelled ${plural(flash.labelled, "row", "rows")}. You can undo it under Recently answered.`
    : flash.undone !== null ? `Undid ${plural(flash.undone, "label", "labels")}${flash.skipped ? `; ${plural(flash.skipped, "row", "rows")} changed since and were left as they are` : ""}.`
    : flash.confirmed !== null ? `Kept ${plural(flash.confirmed, "label", "labels")} as yours.`
    : flash.answer !== null ? "Took back the labels from that answer."
    : flash.saved !== null ? "Saved." : flash.removed !== null ? "Removed. Rows already labelled keep their labels." : null;
  return <main className="mx-auto w-full max-w-[1400px] space-y-5 px-4 py-6 text-foreground sm:px-8 lg:py-8">
    <header>
      <p className="eyebrow">Money</p>
      <h1 className="mt-1 page-title">AI organizer</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">The organizer labels what it is sure of and asks about the rest. Everything it did is listed here, and you can undo it.</p>
    </header>
    <Chips label="Organizer views" items={[{ href: "/money/organize?tab=needs", text: "Needs you", active: tab === "needs", count: needs.rows },
      { href: "/money/organize?tab=decided", text: "AI decided", active: tab === "decided" }, { href: "/money/organize?tab=memory", text: "Memory", active: tab === "memory" }]} />
    {message && <Notice>{message}</Notice>}
    {tab === "needs" && <NeedsTab db={supabase} workspace={workspace} names={names} />}
    {tab === "decided" && <DecidedTab db={supabase} workspace={workspace} names={names} source={source} page={page} />}
    {tab === "memory" && <MemoryTab db={supabase} workspace={workspace} names={names} />}
  </main>;
}

type Tab = { db: SupabaseClient; workspace: { id: string; locale: string; timezone: string }; names: Awaited<ReturnType<typeof loadNames>> };

async function NeedsTab({ db, workspace, names }: Tab) {
  const [questions, answered] = await Promise.all([loadOpenQuestions(db, workspace.id), loadRecentAnswers(db, workspace.id)]);
  return <NeedsYou questions={questions} answered={answered} categories={names.categoryList} merchants={names.merchantList} locale={workspace.locale} timezone={workspace.timezone} />;
}

async function DecidedTab({ db, workspace, names, source, page }: Tab & { source?: Source; page: number }) {
  const [decided, groups] = await Promise.all([loadDecisions(db, workspace.id, { source, page }), loadRunGroups(db, workspace.id)]);
  return <Decided decisions={decided.decisions} total={decided.total} groups={groups} source={source} page={page} categories={names.categories} merchants={names.merchants} locale={workspace.locale} timezone={workspace.timezone} />;
}

async function MemoryTab({ db, workspace, names }: Tab) {
  const [entries, created] = await Promise.all([loadMemory(db, workspace.id), loadAiCreated(db, workspace.id)]);
  return <Memory entries={entries} categories={names.categoryList} merchants={names.merchantList} aiCategories={created.categories} aiMerchants={created.merchants} />;
}

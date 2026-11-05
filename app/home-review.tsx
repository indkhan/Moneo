"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useBusy } from "@/components/use-busy";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, X } from "lucide-react";
import { RecurringCards } from "@/app/money/recurring/cards";
import { decideAgentProposals } from "@/app/ai/agents/actions";
import { displayFormat } from "@/lib/display-format";
import { categorizeGroups, loadUncategorizedGroups, type UncategorizedGroup } from "./home-review-actions";
import type { OpenProposal } from "@/lib/ai/open-proposals";
import type { HomeFinding } from "@/lib/ai/home-review";

const primary = "min-h-9 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50";
const secondary = "min-h-9 rounded-lg border border-border px-4 text-sm hover:bg-muted disabled:opacity-50";

/** A sheet tells its summary card when nothing is left, so the card goes away without waiting for Home to reload. */
const Cleared = createContext<(cleared: boolean) => void>(() => {});

/** One line on Home for a whole kind of decision; Review opens the items in a sheet over the page. */
export function SummaryCard({ title, detail, children }: { title: string; detail: string; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [cleared, setCleared] = useState(false);
  const router = useRouter();
  useEffect(() => { if (open) dialog.current?.showModal(); }, [open]);
  if (cleared && !open) return null;
  return <Cleared.Provider value={setCleared}><section aria-label={title} className="my-3 flex flex-wrap items-center gap-3 rounded-xl border border-ai-border bg-ai-soft p-4">
    <div className="min-w-0 flex-1"><p className="font-medium">{title}</p><p className="mt-0.5 text-sm text-muted-foreground">{detail}</p></div>
    <button type="button" aria-label={`Review: ${title}`} onClick={() => setOpen(true)} className={`${primary} inline-flex items-center gap-1`}>Review<ChevronRight className="size-4" aria-hidden="true" /></button>
    {/* Closing refreshes Home so the counts match what was decided. */}
    {open && <dialog ref={dialog} aria-label={title} onClose={() => { setOpen(false); router.refresh(); }}
      className="m-auto mb-0 max-h-[85dvh] w-full max-w-2xl overflow-y-auto rounded-t-2xl border border-border bg-background p-5 text-foreground backdrop:bg-black/40 sm:mb-auto sm:rounded-2xl">
      <div className="flex items-center gap-2"><h2 className="mr-auto font-display text-lg font-semibold">{title}</h2>
        <button type="button" onClick={() => dialog.current?.close()} aria-label="Close" className="rounded-lg p-2 hover:bg-muted"><X className="size-4" aria-hidden="true" /></button></div>
      {children}
    </dialog>}
  </section></Cleared.Provider>;
}

/** Reports to the summary card whether every item in its sheet is decided. */
function useReportCleared(cleared: boolean) {
  const report = useContext(Cleared);
  useEffect(() => { report(cleared); }, [report, cleared]);
}

function useDecide() {
  const [pending, start] = useBusy();
  const [error, setError] = useState<string>();
  const run = (work: () => Promise<string | void>) => start(async () => {
    setError(undefined);
    try { const failed = await work(); if (failed) setError(failed); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save"); }
  });
  return { pending, error, run };
}

/** Detected and chat-made recurring changes, one decision each: confirming opens the dialog to check amount, date and category. */
export function RecurringSheet({ proposals }: { proposals: OpenProposal[] }) {
  const [decided, setDecided] = useState<Set<string>>(new Set());
  const onDecided = (id: string, undone?: boolean) => setDecided(current => { const next = new Set(current); if (undone) next.delete(id); else next.add(id); return next; });
  const cleared = proposals.every(item => decided.has(item.id));
  useReportCleared(cleared);
  return <div>
    <p className="mt-2 text-sm text-muted-foreground">Confirmed payments go into your forecast. “Not recurring” is remembered.</p>
    <RecurringCards cards={proposals} onDecided={onDecided} />
    {cleared && <p role="status" className="mt-3 text-sm">All reviewed. Nothing else needs a look.</p>}
  </div>;
}

/** Things the checks flagged; “It's fine” closes one for good, Open shows the transaction behind it. */
export function FindingsSheet({ findings, locale = "en-GB" }: { findings: HomeFinding[]; locale?: string }) {
  const { date, money } = displayFormat(locale);
  const { pending, error, run } = useDecide();
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  // Cleared at once; any that fail to save come back with the error.
  const dismiss = (items: HomeFinding[]) => run(async () => {
    const keys = items.map(item => item.ids[0]);
    const restore = (failed: string[]) => setCleared(current => new Set([...current].filter(key => !failed.includes(key))));
    setCleared(current => new Set([...current, ...keys]));
    try {
      const outcomes = await decideAgentProposals(items.flatMap(item => item.ids), "reject");
      const failedIds = new Set(outcomes.filter(item => item.error).map(item => item.id));
      restore(items.filter(item => item.ids.some(id => failedIds.has(id))).map(item => item.ids[0]));
      return outcomes.find(item => item.error)?.error;
    } catch (cause) { restore(keys); throw cause; }
  });
  const left = findings.filter(item => !cleared.has(item.ids[0]));
  useReportCleared(!left.length);
  return <div>
    <div className="mt-2 flex flex-wrap items-center gap-2"><p className="mr-auto text-sm text-muted-foreground">Nothing changes unless you open and fix a transaction.</p>
      {left.length > 1 && <button type="button" disabled={pending} className={secondary} onClick={() => dismiss(left)}>All fine</button>}</div>
    {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    <ul className="mt-2 divide-y divide-border">{left.map(item => <li key={item.ids[0]} className="flex flex-wrap items-center gap-2 py-3">
      <div className="min-w-0 flex-1"><p className="text-sm font-medium">{item.title}</p><p className="mt-0.5 text-xs text-muted-foreground">{item.detail}</p>
        {item.transactions.length > 0 && <details className="mt-1 text-xs text-muted-foreground"><summary className="cursor-pointer hover:text-foreground">Show the {item.transactions.length === 1 ? "transaction" : `${item.transactions.length} transactions`}</summary>
          <ul className="mt-1 divide-y divide-border rounded-lg border border-border bg-background">{item.transactions.map(row => <li key={row.id}>
            <Link href={`/money/transactions?transaction=${row.id}`} className="flex items-baseline gap-3 px-3 py-1.5 hover:bg-muted">
              <span className="flex-1 font-mono">{date(row.date)}</span>
              <span className="shrink-0 font-mono text-foreground">{money(row.amountMinor, row.currency)}</span></Link></li>)}</ul></details>}</div>
      {item.href && <Link href={item.href} className={secondary + " inline-flex items-center"}>Open</Link>}
      <button type="button" disabled={pending} className={secondary} onClick={() => dismiss([item])}>It&apos;s fine</button>
    </li>)}</ul>
    {!left.length && <p role="status" className="mt-3 text-sm">All reviewed. Nothing else needs a look.</p>}
  </div>;
}

/** Uncategorized spending grouped by description: pick a category per group (the suggestion is preselected) or skip it. */
export function UncategorizedSheet({ total, locale = "en-GB" }: { total: number; locale?: string }) {
  const { date, money } = displayFormat(locale);
  const [data, setData] = useState<Awaited<ReturnType<typeof loadUncategorizedGroups>>>();
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Record<string, string>>({});
  const [remember, setRemember] = useState(false);
  const { pending, error, run } = useDecide();
  // A failed load says so; treating it as empty would report everything as reviewed.
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { loadUncategorizedGroups().then(setData, () => setFailed(true)); }, [attempt]);
  const shown = data?.groups.reduce((sum, group) => sum + group.count, 0) ?? 0;
  useReportCleared(!!data && data.total <= shown && data.groups.every(group => done[group.key] && done[group.key] !== "Skipped"));
  if (failed) return <p role="alert" className="mt-3 text-sm text-danger">Could not load these {total} transactions. <button type="button" onClick={() => { setFailed(false); setAttempt(count => count + 1); }} className="underline">Try again</button></p>;
  if (!data) return <p role="status" className="mt-3 text-sm text-muted-foreground">Grouping {total} transactions…</p>;
  const pick = (group: UncategorizedGroup) => chosen[group.key] ?? group.suggested ?? "";
  // Marked done at once; groups that fail to save are put back with the error.
  const apply = (groups: UncategorizedGroup[]) => run(async () => {
    const keys = groups.map(group => group.key);
    const restore = (failed: string[]) => setDone(current => Object.fromEntries(Object.entries(current).filter(([key]) => !failed.includes(key))));
    const outcome = (count: number) => `${count} categorized${remember ? ", future entries too" : ""}`;
    setDone(current => ({ ...current, ...Object.fromEntries(groups.map(group => [group.key, outcome(group.count)])) }));
    try {
      const { applied, error } = await categorizeGroups(groups.map(group => ({ rows: group.rows, categoryId: pick(group), key: group.key })), remember);
      restore(keys.filter(key => !(key in applied)));
      setDone(current => ({ ...current, ...Object.fromEntries(Object.entries(applied).map(([key, count]) => [key, outcome(count)])) }));
      return error;
    } catch (cause) { restore(keys); throw cause; }
  });
  const open = data.groups.filter(group => !done[group.key]);
  const suggested = open.filter(group => group.suggested && pick(group) === group.suggested);
  return <div>
    <div className="mt-2 flex flex-wrap items-center gap-2"><p className="mr-auto text-sm text-muted-foreground">Every batch can be undone.</p>
      {suggested.length > 0 && <button type="button" disabled={pending} className={primary} onClick={() => apply(suggested)}>Apply {suggested.length} suggested</button>}</div>
    <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" className="size-4" checked={remember} disabled={pending} onChange={event => setRemember(event.target.checked)} />Do the same for future entries</label>
    <p className="mt-1 text-xs text-muted-foreground">{remember ? "Applying also saves a rule, so future entries with the same description get this category." : "Applying changes only these transactions. Future entries stay uncategorized."}</p>
    {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    <ul className="mt-2 divide-y divide-border">{data.groups.map(group => <li key={group.key} className="flex flex-wrap items-center gap-2 py-3">
      <div className="w-full min-w-0"><p className="break-words text-sm font-medium">{group.label}</p>
        <details className="text-xs text-muted-foreground"><summary className="cursor-pointer hover:text-foreground">{group.count} {group.count === 1 ? "transaction" : "transactions"}{group.suggested ? " · suggestion preselected" : ""}</summary>
          <ul className="mt-1 divide-y divide-border rounded-lg border border-border bg-background">{group.recent.map(row => <li key={row.id}>
            <Link href={`/money/transactions?transaction=${row.id}`} className="flex items-baseline gap-3 px-3 py-1.5 hover:bg-muted">
              <span className="flex-1 font-mono">{date(row.date)}</span>
              <span className="shrink-0 font-mono text-foreground">{money(row.amountMinor, row.currency)}</span></Link></li>)}</ul>
          {group.count > group.recent.length && <p className="mt-1">…and {group.count - group.recent.length} more.</p>}
        </details></div>
      {done[group.key] ? <p role="status" className="text-sm">{done[group.key]}</p> : <>
        <select aria-label={`Category for ${group.label}`} value={pick(group)} disabled={pending} onChange={event => setChosen(current => ({ ...current, [group.key]: event.target.value }))}
          className="min-h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-sm sm:max-w-56">
          <option value="">Choose…</option>
          {data.categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select>
        <button type="button" disabled={pending || !pick(group)} className={primary} onClick={() => apply([group])}>Apply</button>
        <button type="button" disabled={pending} className={secondary} onClick={() => setDone(current => ({ ...current, [group.key]: "Skipped" }))}>Skip</button>
      </>}
    </li>)}</ul>
    {data.total > data.groups.reduce((sum, group) => sum + group.count, 0) && <p className="mt-3 text-xs text-muted-foreground">Showing the {data.groups.length} biggest groups. <Link href="/money/organization" className="underline">Sort the rest on Organize</Link></p>}
  </div>;
}

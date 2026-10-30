"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, X } from "lucide-react";
import { IouCard } from "@/components/iou-card";
import { decideAgentProposals } from "@/app/ai/agents/actions";
import { categorizeGroup, loadUncategorizedGroups, type UncategorizedGroup } from "./home-review-actions";
import type { OpenProposal } from "@/lib/ai/open-proposals";
import type { HomeFinding } from "@/lib/ai/home-review";

const primary = "min-h-9 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50";
const secondary = "min-h-9 rounded-lg border border-border px-4 text-sm hover:bg-muted disabled:opacity-50";

/** One line on Home for a whole kind of decision; Review opens the items in a sheet over the page. */
export function SummaryCard({ title, detail, children }: { title: string; detail: string; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const router = useRouter();
  useEffect(() => { if (open) dialog.current?.showModal(); }, [open]);
  return <section aria-label={title} className="my-3 flex flex-wrap items-center gap-3 rounded-xl border border-ai-border bg-ai-soft p-4">
    <div className="min-w-0 flex-1"><p className="font-medium">{title}</p><p className="mt-0.5 text-sm text-muted-foreground">{detail}</p></div>
    <button type="button" onClick={() => setOpen(true)} className={`${primary} inline-flex items-center gap-1`}>Review<ChevronRight className="size-4" aria-hidden="true" /></button>
    {/* Closing refreshes Home so the counts match what was decided. */}
    {open && <dialog ref={dialog} aria-label={title} onClose={() => { setOpen(false); router.refresh(); }}
      className="m-auto mb-0 max-h-[85dvh] w-full max-w-2xl overflow-y-auto rounded-t-2xl border border-border bg-background p-5 text-foreground backdrop:bg-black/40 sm:mb-auto sm:rounded-2xl">
      <div className="flex items-center gap-2"><h2 className="mr-auto font-display text-lg font-semibold">{title}</h2>
        <button type="button" onClick={() => dialog.current?.close()} aria-label="Close" className="rounded-lg p-2 hover:bg-muted"><X className="size-4" aria-hidden="true" /></button></div>
      {children}
    </dialog>}
  </section>;
}

function useDecide() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  const run = (work: () => Promise<string | void>) => start(async () => {
    setError(undefined);
    try { const failed = await work(); if (failed) setError(failed); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save"); }
  });
  return { pending, error, run };
}

/** Detected and chat-made recurring changes; each card says yes or no on its own, or all at once. */
export function RecurringSheet({ proposals }: { proposals: OpenProposal[] }) {
  const { pending, error, run } = useDecide();
  const [version, setVersion] = useState(0);
  return <div>
    <div className="mt-2 flex flex-wrap items-center gap-2"><p className="mr-auto text-sm text-muted-foreground">Confirmed payments go into your forecast. “Not recurring” is remembered.</p>
      <button type="button" disabled={pending} className={primary} onClick={() => run(async () => {
        const outcomes = await decideAgentProposals(proposals.map(item => item.id), "accept");
        setVersion(count => count + 1);
        const failed = outcomes.filter(item => item.error);
        return failed.length ? `${failed.length} could not be saved: ${failed[0].error}` : undefined;
      })}>Confirm all</button></div>
    {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    {/* Remounting after Confirm all reloads every card's outcome. */}
    {proposals.map(proposal => <IouCard key={`${proposal.id}:${version}`} id={proposal.id} initial={version ? undefined : proposal} />)}
  </div>;
}

/** Things the checks flagged; “It's fine” closes one for good, Open shows the transaction behind it. */
export function FindingsSheet({ findings }: { findings: HomeFinding[] }) {
  const { pending, error, run } = useDecide();
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const dismiss = (items: HomeFinding[]) => run(async () => {
    const outcomes = await decideAgentProposals(items.flatMap(item => item.ids), "reject");
    setCleared(current => new Set([...current, ...items.map(item => item.ids[0])]));
    return outcomes.find(item => item.error)?.error;
  });
  const left = findings.filter(item => !cleared.has(item.ids[0]));
  return <div>
    <div className="mt-2 flex flex-wrap items-center gap-2"><p className="mr-auto text-sm text-muted-foreground">Nothing changes unless you open and fix a transaction.</p>
      {left.length > 1 && <button type="button" disabled={pending} className={secondary} onClick={() => dismiss(left)}>All fine</button>}</div>
    {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    <ul className="mt-2 divide-y divide-border">{left.map(item => <li key={item.ids[0]} className="flex flex-wrap items-center gap-2 py-3">
      <div className="min-w-0 flex-1"><p className="text-sm font-medium">{item.title}</p><p className="mt-0.5 text-xs text-muted-foreground">{item.detail}</p></div>
      {item.href && <Link href={item.href} className={secondary + " inline-flex items-center"}>Open</Link>}
      <button type="button" disabled={pending} className={secondary} onClick={() => dismiss([item])}>It&apos;s fine</button>
    </li>)}</ul>
    {!left.length && <p role="status" className="mt-3 text-sm">All reviewed.</p>}
  </div>;
}

/** Uncategorized spending grouped by description: pick a category per group (the suggestion is preselected) or skip it. */
export function UncategorizedSheet({ total }: { total: number }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof loadUncategorizedGroups>>>();
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Record<string, string>>({});
  const { pending, error, run } = useDecide();
  useEffect(() => { loadUncategorizedGroups().then(setData, () => setData({ groups: [], total: 0, categories: [] })); }, []);
  if (!data) return <p role="status" className="mt-3 text-sm text-muted-foreground">Grouping {total} transactions…</p>;
  const pick = (group: UncategorizedGroup) => chosen[group.key] ?? group.suggested ?? "";
  const apply = (groups: UncategorizedGroup[]) => run(async () => {
    for (const group of groups) {
      const { applied } = await categorizeGroup({ rows: group.rows, categoryId: pick(group), key: group.key });
      setDone(current => ({ ...current, [group.key]: `${applied} categorized` }));
    }
  });
  const open = data.groups.filter(group => !done[group.key]);
  const suggested = open.filter(group => group.suggested && pick(group) === group.suggested);
  return <div>
    <div className="mt-2 flex flex-wrap items-center gap-2"><p className="mr-auto text-sm text-muted-foreground">Each choice also teaches a rule, so the next sync sorts these by itself. Every batch can be undone.</p>
      {suggested.length > 0 && <button type="button" disabled={pending} className={primary} onClick={() => apply(suggested)}>Apply {suggested.length} suggested</button>}</div>
    {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    <ul className="mt-2 divide-y divide-border">{data.groups.map(group => <li key={group.key} className="flex flex-wrap items-center gap-2 py-3">
      <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{group.label}</p><p className="text-xs text-muted-foreground">{group.count} {group.count === 1 ? "transaction" : "transactions"}{group.suggested ? " · suggestion preselected" : ""}</p></div>
      {done[group.key] ? <p role="status" className="text-sm">{done[group.key]}</p> : <>
        <select aria-label={`Category for ${group.label}`} value={pick(group)} disabled={pending} onChange={event => setChosen(current => ({ ...current, [group.key]: event.target.value }))}
          className="min-h-9 max-w-44 rounded-lg border border-border bg-background px-2 text-sm">
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

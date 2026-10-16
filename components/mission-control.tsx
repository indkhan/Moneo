"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, Check, ChevronRight, CircleDashed, CircleSlash, Info, LoaderCircle, Play, Sparkles, Square, Wrench, X } from "lucide-react";
import { AGENTS, WAVES, type AgentId, type ProposalKind } from "@/lib/agents/team";
import type { AgentProposalView, AgentRunView, AgentTaskView } from "@/lib/agents/state";
import { formatMoney } from "@/lib/finance/format";
import { decideAgentProposals } from "@/app/ai/agents/actions";
import { AskAbout } from "./ask-about";

const ACTIVE = new Set(["queued", "running"]);
const WAVE_LABELS = ["Analysts · in parallel", "Builders · read the analysts' results", "Writer · after the lead merges"];
const KIND_LABELS: Record<ProposalKind, string> = { finding: "Findings", categorize: "Merchants and categories", recurring: "Recurring schedules", budget: "Category limits", tool: "Tools" };
const STATUS_TONE: Record<string, string> = {
  running: "bg-brand/10 text-brand", queued: "bg-muted text-muted-foreground", pending: "bg-muted text-muted-foreground", done: "bg-success-soft text-success", completed: "bg-success-soft text-success",
  failed: "bg-danger-soft text-danger", canceled: "bg-muted text-muted-foreground", skipped: "bg-muted text-muted-foreground",
  proposed: "bg-muted text-muted-foreground", applying: "bg-brand/10 text-brand", accepted: "bg-success-soft text-success", rejected: "bg-muted text-muted-foreground",
};
const pill = (status: string, label = status) => <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_TONE[status] ?? "bg-muted"}`}>{label}</span>;

function StatusIcon({ status }: { status: string }) {
  if (status === "running") return <LoaderCircle className="size-4 animate-spin text-brand" aria-label="Running" />;
  if (status === "done") return <Check className="size-4 text-success" aria-label="Done" />;
  if (status === "failed") return <X className="size-4 text-danger" aria-label="Failed" />;
  if (status === "skipped" || status === "canceled") return <CircleSlash className="size-4 text-muted-foreground" aria-label={status} />;
  return <CircleDashed className="size-4 text-muted-foreground" aria-label="Waiting" />;
}
const EVENT_ICON = { tool: Wrench, finding: Sparkles, note: Info, step: ChevronRight } as const;

function duration(task: AgentTaskView) {
  if (!task.started_at) return "";
  const ms = (task.finished_at ? Date.parse(task.finished_at) : Date.now()) - Date.parse(task.started_at);
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function AgentCard({ task }: { task: AgentTaskView }) {
  const meta = AGENTS[task.agent];
  return <article aria-label={meta.name} className={`flex min-w-0 flex-col rounded-xl border bg-card p-4 ${task.status === "running" ? "border-brand shadow-[0_0_0_3px] shadow-brand/10" : "border-border"}`}>
    <header className="flex items-start gap-2">
      <StatusIcon status={task.status} />
      <div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">{meta.name}</h3><p className="text-xs text-muted-foreground">{meta.role}</p></div>
      {pill(task.status)}
    </header>
    {task.step && task.status !== "done" && <p className="mt-2 text-sm" aria-live="polite">{task.step}</p>}
    {task.events.length > 0 && <ol className="mt-2 max-h-40 space-y-1 overflow-y-auto border-l-2 border-border pl-3 text-xs text-muted-foreground">
      {task.events.filter(event => event.type !== "step" || event.text !== "Done").slice(-8).map((event, index) => {
        const Icon = EVENT_ICON[event.type as keyof typeof EVENT_ICON] ?? ChevronRight;
        return <li key={`${event.at}-${index}`} className={`flex gap-1.5 ${event.type === "tool" ? "font-mono text-[11px]" : ""} ${event.type === "finding" ? "text-foreground" : ""}`}><Icon className="mt-0.5 size-3 shrink-0" aria-hidden="true" /><span className="min-w-0 break-words">{event.text}</span></li>;
      })}
    </ol>}
    {task.summary && (task.status === "done" || task.status === "skipped") && <p className="mt-auto pt-3 text-xs text-muted-foreground">{task.summary}{task.status === "done" && <span className="ml-1 font-mono">· {duration(task)}</span>}</p>}
  </article>;
}

function EvidenceView({ proposal, locale }: { proposal: AgentProposalView; locale: string }) {
  const { facts, transactions, links } = proposal.evidence;
  return <details className="mt-2 text-xs">
    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Evidence</summary>
    <div className="mt-2 space-y-2 rounded-lg bg-muted/50 p-3">
      {facts.length > 0 && <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">{facts.map(fact => <div key={fact.label} className="contents"><dt className="text-muted-foreground">{fact.label}</dt><dd className="font-mono">{fact.value}</dd></div>)}</dl>}
      {transactions.length > 0 && <ul className="divide-y divide-border">{transactions.map(row => <li key={row.id}><Link href={`/money/transactions?transaction=${row.id}`} className="flex gap-3 py-1 hover:underline">
        <span className="w-20 shrink-0 font-mono text-muted-foreground">{row.date}</span><span className="min-w-0 flex-1 truncate">{row.description}</span><span className="shrink-0 font-mono">{formatMoney(row.amountMinor, row.currency, locale)}</span></Link></li>)}</ul>}
      {links.length > 0 && <p className="flex flex-wrap gap-3">{links.map(link => <Link key={link.href + link.label} href={link.href} className="text-brand underline">{link.label}</Link>)}</p>}
    </div>
  </details>;
}

/** Live mission control for one agent-team run, with the review screen at the end. */
export function MissionControl({ initial, locale }: { initial: AgentRunView; locale: string }) {
  const [run, setRun] = useState(initial);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const active = ACTIVE.has(run.status);

  async function refresh() {
    const response = await fetch(`/api/agents/runs/${run.id}`, { cache: "no-store" });
    if (response.ok) setRun(await response.json());
  }
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const tick = async () => { try { const response = await fetch(`/api/agents/runs/${initial.id}`, { cache: "no-store" }); if (response.ok && !stopped) setRun(await response.json()); } catch { /* next tick retries */ } };
    const timer = window.setInterval(() => void tick(), 1200);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [active, initial.id]);

  async function control(action: "cancel" | "resume") {
    setNotice("");
    const response = await fetch(`/api/agents/runs/${run.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) setNotice(body.error ?? "Request failed");
    await refresh();
  }

  function decide(ids: string[], decision: "accept" | "reject") {
    if (!ids.length) return;
    setNotice("");
    startTransition(async () => {
      try {
        const outcomes = await decideAgentProposals(ids, decision);
        const failed = outcomes.filter(outcome => outcome.status === "failed");
        setNotice(failed.length ? `${failed.length} could not be applied: ${failed[0].error}` : `${outcomes.filter(outcome => outcome.status !== "unchanged").length} ${decision === "accept" ? "accepted" : "rejected"}.`);
        setSelected(new Set());
        await refresh();
        router.refresh();
      } catch (cause) { setNotice(cause instanceof Error ? cause.message : "Could not save decisions"); }
    });
  }

  const byAgent = new Map(run.tasks.map(task => [task.agent, task]));
  const lead = byAgent.get("lead");
  const open = run.proposals.filter(item => item.status === "proposed" || item.status === "failed");
  const reviewable = !active;
  const toggle = (id: string) => setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const kinds = (Object.keys(KIND_LABELS) as ProposalKind[]).filter(kind => run.proposals.some(item => item.kind === kind));
  const model = run.model_status === "available" || run.model_status === "budget_exhausted" ? `Free model · ${run.model_calls}/${run.model_budget} calls`
    : run.model_status === "unknown" ? "Checking model…" : "Deterministic only (no free model)";

  return <div className="space-y-6">
    <header className="flex flex-wrap items-center gap-3">
      <div className="mr-auto min-w-0">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight"><Bot className="size-6 text-brand" aria-hidden="true" />Agent team {pill(run.status)}</h1>
        <p className="text-sm text-muted-foreground">{run.trigger === "import" ? "Started when your import finished" : "Started manually"} · {new Date(run.created_at).toLocaleString(locale)} · {model}</p>
      </div>
      {active && <button type="button" onClick={() => void control("cancel")} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted"><Square className="size-3.5" aria-hidden="true" />Stop</button>}
      {(run.status === "canceled" || run.status === "failed") && <button type="button" onClick={() => void control("resume")} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"><Play className="size-3.5" aria-hidden="true" />Resume</button>}
    </header>
    {run.error && <p role="alert" className="rounded-lg bg-danger-soft p-3 text-sm text-danger">{run.error}</p>}

    {lead && <section aria-label="Lead agent" className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2"><StatusIcon status={lead.status} /><h2 className="text-sm font-semibold">Lead</h2><span className="text-xs text-muted-foreground">{lead.summary ?? lead.step}</span></div>
      <ol className="mt-2 grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">{lead.events.slice(-8).map((event, index) => <li key={`${event.at}-${index}`} className="flex gap-1.5"><ChevronRight className="mt-0.5 size-3 shrink-0" aria-hidden="true" />{event.text}</li>)}</ol>
    </section>}

    {WAVES.map((wave, index) => {
      const tasks = wave.map(agent => byAgent.get(agent)).filter((task): task is AgentTaskView => Boolean(task));
      return tasks.length > 0 && <section key={index} aria-label={WAVE_LABELS[index]} className="space-y-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Wave {index + 1} · {WAVE_LABELS[index]}</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{tasks.map(task => <AgentCard key={task.agent} task={task} />)}</div>
      </section>;
    })}
    {!run.tasks.length && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" aria-hidden="true" />The lead is planning the work…</p>}

    {run.briefing && <section aria-label="Briefing" className="rounded-xl border border-brand/40 bg-card p-5">
      <h2 className="flex items-center gap-2 text-base font-semibold"><Sparkles className="size-4 text-brand" aria-hidden="true" />Briefing</h2>
      <div className="mt-2 space-y-2 text-sm leading-relaxed">{run.briefing.split(/\n{2,}/).map(paragraph => <p key={paragraph}>{paragraph}</p>)}</div>
      <p className="mt-2 text-xs text-muted-foreground">Every figure comes from application code; the writer is only allowed to repeat them.</p>
    </section>}

    <section aria-labelledby="review-heading" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="review-heading" className="mr-auto text-base font-semibold">Review <span className="text-muted-foreground">({open.length} open of {run.proposals.length})</span></h2>
        {reviewable && open.length > 0 && <>
          <button type="button" onClick={() => setSelected(selected.size === open.length ? new Set() : new Set(open.map(item => item.id)))} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted">{selected.size === open.length ? "Clear selection" : "Select all"}</button>
          <button type="button" disabled={pending || !selected.size} onClick={() => decide([...selected], "reject")} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50">Reject selected</button>
          <button type="button" disabled={pending || !selected.size} onClick={() => decide([...selected], "accept")} className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">{pending ? "Applying…" : `Accept selected (${selected.size})`}</button>
        </>}
      </div>
      <p className="text-xs text-muted-foreground">{reviewable ? "Nothing changes until you accept. Accepted changes use the same audited actions as the rest of Moneo, so history and Undo keep working." : "Proposals stream in as agents work. Review opens when the team finishes."}</p>
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {kinds.map(kind => <div key={kind} className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{KIND_LABELS[kind]}</h3>
        <ul className="space-y-2">{run.proposals.filter(item => item.kind === kind).map(item => {
          const decidable = reviewable && (item.status === "proposed" || item.status === "failed");
          return <li key={item.id} className="rounded-xl border border-border bg-card p-3">
            <div className="flex items-start gap-3">
              <input type="checkbox" aria-label={`Select ${item.title}`} disabled={!decidable} checked={selected.has(item.id)} onChange={() => toggle(item.id)} className="mt-1 size-4" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><p className="text-sm font-medium">{item.title}</p><span className="text-xs text-muted-foreground">{AGENTS[item.agent as AgentId]?.name}</span>
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title="Heuristic confidence, not a probability"><span className="h-1.5 w-12 overflow-hidden rounded-full bg-muted"><span className="block h-full bg-brand" style={{ width: `${item.confidence}%` }} /></span>{item.confidence}</span>
                  {item.status !== "proposed" && pill(item.status)}</div>
                <p className="mt-0.5 text-xs text-muted-foreground">{item.detail}</p>
                {item.notes.map(note => <p key={note} className="mt-1 text-xs text-warning">Lead: {note}</p>)}
                {item.status === "failed" && item.result?.error && <p className="mt-1 text-xs text-danger">{item.result.error}</p>}
                {item.status === "accepted" && item.result?.href && <p className="mt-1 text-xs"><Link href={item.result.href} className="text-brand underline">Open</Link>{item.result.undo && <span className="text-muted-foreground"> · {item.result.undo}</span>}</p>}
                <EvidenceView proposal={item} locale={locale} />
                <AskAbout label="Ask why" question={`The ${AGENTS[item.agent as AgentId]?.name ?? "agent"} proposed “${item.title}”. Check the underlying transactions and tell me whether I should accept it.`} about={{ kind: "agent_proposal", id: item.id, label: item.title.slice(0, 80) }} className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" />
              </div>
              {decidable && <div className="flex shrink-0 gap-1">
                <button type="button" disabled={pending} onClick={() => decide([item.id], "reject")} className="rounded-lg border border-border px-2.5 py-1 text-xs hover:bg-muted">Reject</button>
                <button type="button" disabled={pending} onClick={() => decide([item.id], "accept")} className="rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90">{kind === "finding" ? "Mark reviewed" : "Accept"}</button>
              </div>}
            </div>
          </li>;
        })}</ul>
      </div>)}
      {!run.proposals.length && !active && <p className="rounded-xl border border-dashed border-border p-5 text-center text-sm text-muted-foreground">The team found nothing that needs a decision.</p>}
    </section>
  </div>;
}

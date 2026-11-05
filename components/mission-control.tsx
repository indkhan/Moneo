"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronRight, CircleDashed, CircleSlash, Info, LoaderCircle, Play, Sparkles, Square, Wrench, X } from "lucide-react";
import { AGENTS, WAVES, type AgentId, type ProposalKind } from "@/lib/ai/agent-team";
import type { AgentProposalView, AgentRunView, AgentTaskView } from "@/lib/ai/agent-state";
import { formatMoney } from "@/lib/finance/format";
import { decideAgentProposals } from "@/app/ai/agents/actions";
import { AskAbout } from "./ask-about";
import { TeamFlow } from "./team-flow";
import { PhoneCollapse } from "./phone-collapse";

const ACTIVE = new Set(["queued", "running"]);
// Category limits score 75 when all three months have spending and 55 when one is empty.
const HIGH_CONFIDENCE = 75;
// decideAgentProposals accepts at most this many ids per call.
const BULK_LIMIT = 100;
// Long runs stay readable: the rest of a group is one press away.
const GROUP_PREVIEW = 5;
const WAVE_LABELS = ["Analysts · in parallel", "Builders · read the analysts' results", "Writer · after the lead merges"];
const KIND_LABELS: Record<ProposalKind, string> = { finding: "Findings", categorize: "Merchants and categories", recurring: "Recurring schedules", budget: "Category limits" };
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
  return <article aria-label={meta.name} className={`flex min-w-0 flex-col rounded-xl border bg-card p-4 ${task.status === "running" ? "border-ai shadow-[0_0_0_3px] shadow-ai/15" : "border-border"}`}>
    <header className="flex items-start gap-2">
      <StatusIcon status={task.status} />
      <div className="min-w-0 flex-1"><h3 className="text-sm font-medium">{meta.name}</h3><p className="text-xs text-muted-foreground">{meta.role}</p></div>
      {pill(task.status)}
    </header>
    {task.step && task.status !== "done" && <p className="mt-2 text-sm">{task.step}</p>}
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
    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Evidence<span className="sr-only"> for {proposal.title}</span></summary>
    <div className="mt-2 space-y-2 rounded-lg bg-muted/50 p-3">
      {facts.length > 0 && <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">{facts.map(fact => <div key={fact.label} className="contents"><dt className="text-muted-foreground">{fact.label}</dt><dd className="min-w-0 break-words font-mono">{fact.value}</dd></div>)}</dl>}
      {transactions.length > 0 && <ul className="divide-y divide-border">{transactions.map(row => <li key={row.id}><Link href={`/money/transactions?transaction=${row.id}`} className="flex flex-wrap gap-x-3 py-1 hover:underline">
        <span className="shrink-0 font-mono text-muted-foreground">{row.date}</span><span className="min-w-0 flex-1 basis-40 break-words">{row.description}</span><span className="shrink-0 font-mono">{formatMoney(row.amountMinor, row.currency, locale)}</span></Link></li>)}</ul>}
      {links.length > 0 && <p className="flex flex-wrap gap-3">{links.map(link => <Link key={link.href + link.label} href={link.href} className="text-brand underline">{link.label}</Link>)}</p>}
    </div>
  </details>;
}

/** Live mission control for one agent-team run, with the review screen at the end. */
export function MissionControl({ initial, locale }: { initial: AgentRunView; locale: string }) {
  const [run, setRun] = useState(initial);
  const [notice, setNotice] = useState("");
  const [pending, startTransition] = useTransition();
  const [lost, setLost] = useState(false);
  const [controlling, setControlling] = useState<"cancel" | "resume" | null>(null);
  const [agentFilter, setAgentFilter] = useState<string>("all");
  // Accepting several at once always shows the list first.
  const [bulk, setBulk] = useState<{ ids: string[]; label: string } | null>(null);
  const [expanded, setExpanded] = useState<ProposalKind[]>([]);
  const router = useRouter();
  const active = ACTIVE.has(run.status);

  async function refresh() {
    const response = await fetch(`/api/agents/runs/${run.id}`, { cache: "no-store" });
    if (response.ok) setRun(await response.json());
  }
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let failures = 0;
    // Polling keeps trying, but after a few misses the page says its progress may be out of date.
    const tick = async () => {
      try {
        const response = await fetch(`/api/agents/runs/${initial.id}`, { cache: "no-store" });
        if (!response.ok) throw new Error();
        const next = await response.json();
        if (!stopped) { setRun(next); failures = 0; setLost(false); }
      } catch { failures += 1; if (failures >= 3 && !stopped) setLost(true); }
    };
    const timer = window.setInterval(() => void tick(), 1200);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [active, initial.id]);

  async function control(action: "cancel" | "resume") {
    if (controlling) return;
    setNotice(""); setControlling(action);
    try {
      const response = await fetch(`/api/agents/runs/${run.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) setNotice(body.error ?? "That did not work. Try again.");
      await refresh();
    } catch { setNotice("Could not reach Moneo. Check your connection and try again."); }
    finally { setControlling(null); }
  }

  function decide(ids: string[], decision: "accept" | "reject") {
    if (!ids.length) return;
    setNotice(""); setBulk(null);
    startTransition(async () => {
      try {
        const outcomes = await decideAgentProposals(ids, decision);
        const failed = outcomes.filter(outcome => outcome.status === "failed");
        setNotice(failed.length ? `${failed.length} could not be applied: ${failed[0].error}` : `${outcomes.filter(outcome => outcome.status !== "unchanged").length} ${decision === "accept" ? "accepted" : "rejected"}.`);
        await refresh();
        router.refresh();
      } catch (cause) { setNotice(cause instanceof Error ? cause.message : "Could not save decisions"); }
    });
  }

  const byAgent = new Map(run.tasks.map(task => [task.agent, task]));
  const lead = byAgent.get("lead");
  const decided = run.proposals.filter(item => item.result?.auto);
  const manual = run.proposals.filter(item => !item.result?.auto);
  const open = manual.filter(item => item.status === "proposed" || item.status === "failed");
  const reviewable = !active;
  const agents = [...new Set(manual.map(item => item.agent))];
  const shown = manual.filter(item => agentFilter === "all" || item.agent === agentFilter);
  const kinds = (Object.keys(KIND_LABELS) as ProposalKind[]).filter(kind => shown.some(item => item.kind === kind));
  const openHere = open.filter(item => item.kind === "budget");
  const openOnHome = open.length - openHere.length;
  const sureThings = reviewable ? openHere.filter(item => item.status === "proposed" && item.confidence >= HIGH_CONFIDENCE).slice(0, BULK_LIMIT) : [];
  const finishedTasks = run.tasks.filter(task => ["done", "failed", "skipped", "canceled"].includes(task.status)).length;
  // Only category limits are decided here; everything else waits on Home, so a decision has one place.
  const openIds = (kind: ProposalKind) => open.filter(item => item.kind === kind && kind === "budget").map(item => item.id);
  const model = run.model_status === "available" || run.model_status === "budget_exhausted" ? `Free model · ${run.model_calls}/${run.model_budget} calls`
    : run.model_status === "unknown" ? "Checking model…" : "Deterministic only (no free model)";

  const team = <PhoneCollapse label={active ? "Show activity" : "How the team worked"}><div className="space-y-6">
    {!active && run.tasks.length > 0 && <h2 className="eyebrow">How the team worked</h2>}
    {run.tasks.length > 0 && <TeamFlow statuses={Object.fromEntries(run.tasks.map(task => [task.agent, task.status]))} finished={run.status === "completed"} />}
    {lead && <section aria-label="Lead agent" className="rounded-xl border border-ai-border bg-ai-soft p-5">
      <div className="flex items-center gap-2"><StatusIcon status={lead.status} /><h2 className="text-sm font-medium text-ai">Lead</h2><span className="text-xs text-muted-foreground">{lead.summary ?? lead.step}</span></div>
      <ol className="mt-2 grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">{lead.events.slice(-8).map((event, index) => <li key={`${event.at}-${index}`} className="flex gap-1.5"><ChevronRight className="mt-0.5 size-3 shrink-0" aria-hidden="true" />{event.text}</li>)}</ol>
    </section>}

    {WAVES.map((wave, index) => {
      const tasks = wave.map(agent => byAgent.get(agent)).filter((task): task is AgentTaskView => Boolean(task));
      return tasks.length > 0 && <section key={index} aria-label={WAVE_LABELS[index]} className="space-y-2">
        <h2 className="eyebrow">Wave {index + 1} · {WAVE_LABELS[index]}</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{tasks.map(task => <AgentCard key={task.agent} task={task} />)}</div>
      </section>;
    })}
    {!run.tasks.length && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" aria-hidden="true" />The lead is planning the work…</p>}
  </div></PhoneCollapse>;

  return <div className="space-y-6">
    <header className="flex flex-wrap items-center gap-3">
      <div className="mr-auto min-w-0">
        <Link href="/ai/agents" className="text-sm text-muted-foreground hover:underline">← All runs</Link>
        <h1 className="mt-1 flex flex-wrap items-center gap-3 page-title">Agent team {pill(run.status)}</h1>
        <p className="text-sm text-muted-foreground">{run.trigger === "import" ? <>Started when {run.import_id ? <Link href={`/import/${run.import_id}/review`} className="underline">your import</Link> : "your import"} finished</> : "Started manually"} · {new Date(run.created_at).toLocaleString(locale)} · {model}</p>
      </div>
      {active && <button type="button" disabled={!!controlling} onClick={() => void control("cancel")} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"><Square className="size-3.5" aria-hidden="true" />{controlling === "cancel" ? "Stopping…" : "Stop"}</button>}
      {(run.status === "canceled" || run.status === "failed") && <button type="button" disabled={!!controlling} onClick={() => void control("resume")} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"><Play className="size-3.5" aria-hidden="true" />{controlling === "resume" ? "Resuming…" : "Resume"}</button>}
    </header>
    {/* One calm announcement for the whole run, rather than one per agent. */}
    <p role="status" className="sr-only">Run {run.status}. {finishedTasks} of {run.tasks.length} agents finished. {open.length} open {open.length === 1 ? "decision" : "decisions"}.</p>
    {lost && active && <p role="alert" className="rounded-lg bg-warning-soft p-3 text-sm text-warning">Lost contact with this run, so its progress may be out of date. Moneo keeps trying.</p>}
    <p className="text-xs text-muted-foreground">{active ? "Stopping keeps changes already made; they stay in history with Undo. " : ""}Category changes the team is sure of are made automatically and can be undone. Flagged items and recurring payments wait on Home. Category limits wait here.</p>
    {active && <p className="text-sm text-muted-foreground">{finishedTasks} of {run.tasks.length} agents finished · {manual.length} found so far</p>}
    {active && team}
    {run.error && <p role="alert" className="rounded-lg bg-danger-soft p-3 text-sm text-danger">{run.error}</p>}

    {run.briefing && <section aria-label="Briefing" className="rounded-xl border border-border bg-card p-6 sm:p-7">
      <h2 className="flex items-center gap-2 text-sm font-medium"><Sparkles className="size-4 text-ai" aria-hidden="true" />Briefing</h2>
      <div className="mt-3 space-y-2 text-[15px] leading-relaxed text-pretty">{run.briefing.split(/\n{2,}/).map(paragraph => <p key={paragraph}>{paragraph}</p>)}</div>
      <p className="mt-2 text-xs text-muted-foreground">Every figure comes from application code; the writer is only allowed to repeat them.</p>
    </section>}

    <section aria-labelledby="review-heading" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="review-heading" className="mr-auto font-display text-2xl font-semibold tracking-tight">What the team found <span className="font-sans text-sm font-normal text-muted-foreground">({manual.length})</span></h2>
        {open.some(item => item.kind !== "budget") && <Link href="/" className="h-10 rounded-[10px] bg-primary px-4 py-2.5 text-[13px] font-medium text-primary-foreground hover:opacity-90">Decide on Home</Link>}
      </div>
      <p className="text-xs text-muted-foreground">{reviewable ? "Accepted changes use the same audited actions as the rest of Moneo, so history and Undo keep working." : "Results stream in as agents work."}</p>
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {reviewable && (open.length > 0 || manual.length > 0) && <div className="sticky top-19 z-10 space-y-2 rounded-xl border border-border bg-card p-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <p className="mr-auto font-medium">{open.length ? <>{open.length} open {open.length === 1 ? "decision" : "decisions"}{openHere.length > 0 && openOnHome > 0 ? <span className="font-normal text-muted-foreground"> · {openHere.length} here, {openOnHome} on Home</span> : openOnHome > 0 ? <span className="font-normal text-muted-foreground"> · on Home</span> : null}</> : "No open decisions"}</p>
          {sureThings.length > 0 && <button type="button" disabled={pending} onClick={() => setBulk({ ids: sureThings.map(item => item.id), label: "high-confidence limits" })} className="min-h-11 rounded-[10px] bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 sm:min-h-9">Accept {sureThings.length} high confidence…</button>}
        </div>
        {bulk && <div role="group" aria-label="Confirm accepting these" className="space-y-2 border-t border-border pt-2">
          <p>Accept these {bulk.ids.length} {bulk.label}? Each stays in history with Undo. Nothing is accepted until you confirm.</p>
          <ul className="max-h-40 list-disc space-y-0.5 overflow-y-auto pl-5 text-[13px]">{manual.filter(item => bulk.ids.includes(item.id)).map(item => <li key={item.id}>{item.title}</li>)}</ul>
          <div className="flex gap-2"><button type="button" disabled={pending} onClick={() => decide(bulk.ids, "accept")} className="min-h-10 rounded-[10px] bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">Confirm {bulk.ids.length}</button><button type="button" onClick={() => setBulk(null)} className="min-h-10 rounded-[10px] border border-input px-3 text-[13px] hover:bg-muted">Cancel</button></div>
        </div>}
      </div>}
      {agents.length > 1 && <div role="group" aria-label="Show results from" className="flex flex-wrap gap-1.5">{["all", ...agents].map(agent => {
        const count = agent === "all" ? manual.length : manual.filter(item => item.agent === agent).length;
        return <button key={agent} type="button" aria-pressed={agentFilter === agent} onClick={() => setAgentFilter(agent)} className="min-h-11 rounded-full border border-input px-3 text-[13px] hover:bg-muted aria-pressed:border-brand aria-pressed:bg-brand aria-pressed:text-white sm:min-h-8">{agent === "all" ? "All" : AGENTS[agent as AgentId]?.name ?? agent} ({count})</button>;
      })}</div>}
      {kinds.map((kind, index) => <details key={kind} open={index === 0 || openIds(kind).length > 0} className="space-y-2 group">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 [&::-webkit-details-marker]:hidden"><ChevronRight className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" /><h3 className="eyebrow">{KIND_LABELS[kind]} ({shown.filter(item => item.kind === kind).length})</h3>{reviewable && openIds(kind).length > 0 && <span className="ml-auto flex gap-1.5">
          <button type="button" disabled={pending} onClick={event => { event.preventDefault(); decide(openIds(kind).slice(0, BULK_LIMIT), "reject"); }} className="h-8 rounded-[10px] border border-input px-3 text-xs hover:bg-muted disabled:opacity-50">Reject {openIds(kind).length > BULK_LIMIT ? `first ${BULK_LIMIT}` : "all"}</button>
          <button type="button" disabled={pending} onClick={event => { event.preventDefault(); setBulk({ ids: openIds(kind).slice(0, BULK_LIMIT), label: KIND_LABELS[kind].toLowerCase() }); }} className="h-8 rounded-[10px] bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">Accept {openIds(kind).length > BULK_LIMIT ? `first ${BULK_LIMIT}` : "all"}…</button>
        </span>}</summary>
        <ul className="space-y-2">{shown.filter(item => item.kind === kind).sort((a, b) => Number(openIds(kind).includes(b.id)) - Number(openIds(kind).includes(a.id))).slice(0, expanded.includes(kind) ? undefined : GROUP_PREVIEW).map(item => {
          const decidable = reviewable && kind === "budget" && (item.status === "proposed" || item.status === "failed");
          return <li key={item.id} className={`rounded-2xl border bg-card px-5 py-[18px] ${item.status === "accepted" ? "border-brand/40" : "border-border"} ${item.status === "rejected" ? "opacity-60" : ""}`}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><p className="text-[15px] font-medium">{item.title}</p>
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title="A rule-of-thumb score from the pattern, not a probability">Pattern strength <span className="h-1.5 w-12 overflow-hidden rounded-full bg-muted"><span className="block h-full bg-brand" style={{ width: `${item.confidence}%` }} /></span>{item.confidence}</span>
                  {item.status !== "proposed" ? pill(item.status, item.result?.movedToHome ? "moved to Home" : item.status) : kind !== "budget" && pill("proposed", "on Home")}</div>
                <p className="mt-1 text-[13px] text-muted-foreground text-pretty">{item.detail}</p>
                {item.notes.map(note => <p key={note} className="mt-1 text-xs text-warning">Lead: {note}</p>)}
                {item.status === "failed" && item.result?.error && <p className="mt-1 text-xs text-danger">{item.result.error}</p>}
                {item.status === "accepted" && item.result?.href && <p className="mt-1 text-xs"><Link href={item.result.href} className="text-brand underline">Open</Link>{item.result.undo && <span className="text-muted-foreground"> · {item.result.undo}</span>}</p>}
                <EvidenceView proposal={item} locale={locale} />
                <AskAbout label="Ask why" question={`The ${AGENTS[item.agent as AgentId]?.name ?? "agent"} proposed “${item.title}”. Check the underlying transactions and tell me whether I should accept it.`} about={{ kind: "agent_proposal", id: item.id, label: item.title.slice(0, 80) }} className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" />
              </div>
              {decidable && <div className="flex shrink-0 gap-1.5">
                <button type="button" disabled={pending} onClick={() => decide([item.id], "reject")} aria-label={`Reject ${item.title}`} className="h-11 rounded-xl border border-input px-4 text-[13px] hover:bg-muted">Reject</button>
                <button type="button" disabled={pending} onClick={() => decide([item.id], "accept")} aria-label={`Accept ${item.title}`} className="h-11 rounded-xl bg-foreground px-[18px] text-[13px] font-medium text-background hover:opacity-90">Accept</button>
              </div>}
            </div>
          </li>;
        })}</ul>
        {!expanded.includes(kind) && shown.filter(item => item.kind === kind).length > GROUP_PREVIEW && <button type="button" onClick={() => setExpanded(current => [...current, kind])} className="min-h-11 text-sm underline">Show all {shown.filter(item => item.kind === kind).length}</button>}
      </details>)}
      {!run.proposals.length && !active && <p className="rounded-xl border border-dashed border-border p-5 text-center text-sm text-muted-foreground">The team found nothing that needs a decision.</p>}
    </section>

    {decided.length > 0 && <PhoneCollapse label={`Decided automatically (${decided.length})`}><section aria-labelledby="decided-heading" className="space-y-2">
      <h2 id="decided-heading" className="text-sm font-medium">Decided automatically <span className="text-muted-foreground">({decided.length})</span></h2>
      <p className="text-xs text-muted-foreground">The Categorizer applied these itself. Each one is an audited batch; open it to check the rows or Undo.</p>
      <ul className="space-y-2">{decided.map(item => <li key={item.id} className="rounded-2xl border border-border bg-card px-5 py-4">
        <div className="flex flex-wrap items-center gap-2"><p className="text-sm font-medium">{item.title}</p>{pill(item.status, "applied")}</div>
        <p className="mt-0.5 text-xs text-muted-foreground">{item.detail}</p>
        {item.result?.href && <p className="mt-1 text-xs"><Link href={item.result.href} className="text-brand underline">Open · Undo</Link></p>}
        <EvidenceView proposal={item} locale={locale} />
      </li>)}</ul>
    </section></PhoneCollapse>}

    {!active && team}
  </div>;
}

"use client";

import { useActionState, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight, Copy, Download, Trash2 } from "lucide-react";
import { LOG_AREAS, LOG_AREA_LABELS, LOG_LEVELS, type LogLevel } from "@/lib/logs/options";
import type { LogEntryView } from "@/lib/logs/redact";
import type { LogFilter } from "@/lib/logs/store";
import { deleteAllLogsSafely } from "./log-actions";

const WINDOW_LABELS = { "1h": "Last hour", "24h": "Last 24 hours", "7d": "Last 7 days", "30d": "Last 30 days", all: "All time" } as const;
const LEVEL_STYLE: Record<LogLevel, string> = { error: "bg-danger-soft text-danger", warn: "bg-warning-soft text-warning", info: "bg-muted text-muted-foreground" };
const control = "min-h-10 rounded-lg border border-border bg-background px-3 text-sm";
const button = "inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium hover:bg-muted disabled:opacity-60";

function query(filter: LogFilter, extra: Record<string, string> = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filter, ...extra })) if (value) params.set(key, String(value));
  return params.toString();
}

function save(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  link.click();
  URL.revokeObjectURL(url);
}

export function LogList({ initial, more: initialMore, filter, timeZone, locale }: { initial: LogEntryView[]; more: boolean; filter: LogFilter; timeZone: string; locale: string }) {
  const [entries, setEntries] = useState(initial);
  const [more, setMore] = useState(initialMore);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const time = useMemo(() => new Intl.DateTimeFormat(locale, { timeZone, dateStyle: "medium", timeStyle: "medium" }), [locale, timeZone]);

  async function loadOlder() {
    const last = entries.at(-1);
    if (!last) return;
    setLoading(true);
    setProblem(null);
    try {
      const response = await fetch(`/api/logs?${query(filter, { before: last.created_at })}`);
      if (!response.ok) throw new Error("Older logs could not be loaded. Try again.");
      const page = await response.json() as { entries: LogEntryView[]; more: boolean };
      setEntries(current => [...current, ...page.entries]);
      setMore(page.more);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Older logs could not be loaded. Try again.");
    } finally { setLoading(false); }
  }

  return <div className="mt-4 space-y-4">
    <form method="get" action="/settings/diagnostics#logs" className="grid gap-2 sm:flex sm:flex-wrap sm:items-end" aria-label="Filter logs">
      <label className="grid gap-1 text-xs text-muted-foreground">Level
        <select name="level" defaultValue={filter.level ?? ""} className={control}><option value="">All levels</option>{LOG_LEVELS.map(level => <option key={level} value={level}>{level === "warn" ? "Warnings" : level === "error" ? "Errors" : "Info"}</option>)}</select>
      </label>
      <label className="grid gap-1 text-xs text-muted-foreground">Area
        <select name="area" defaultValue={filter.area ?? ""} className={control}><option value="">All areas</option>{LOG_AREAS.map(area => <option key={area} value={area}>{LOG_AREA_LABELS[area]}</option>)}</select>
      </label>
      <label className="grid gap-1 text-xs text-muted-foreground">Time
        <select name="window" defaultValue={filter.window} className={control}>{Object.entries(WINDOW_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      </label>
      <label className="grid gap-1 text-xs text-muted-foreground sm:min-w-56 sm:flex-1">Search
        <input type="search" name="q" defaultValue={filter.q ?? ""} placeholder="Search messages and events" className={control} />
      </label>
      <button type="submit" className={button}>Show</button>
    </form>
    <LogTools filter={filter} count={entries.length} />
    {entries.length === 0 ? <p className="text-sm text-muted-foreground">No log entries match. Moneo logs what it does as you use it.</p> :
      <ol className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {entries.map(entry => <LogRow key={entry.id} entry={entry} time={time.format(new Date(entry.created_at))} />)}
      </ol>}
    {problem && <p role="alert" className="text-sm text-danger">{problem}</p>}
    {more && <button type="button" onClick={() => void loadOlder()} disabled={loading} className={button}>{loading ? "Loading…" : "Load older entries"}</button>}
  </div>;
}

function LogRow({ entry, time }: { entry: LogEntryView; time: string }) {
  const [open, setOpen] = useState(false);
  const details = entry.details && typeof entry.details === "object" && !Array.isArray(entry.details) ? entry.details as Record<string, unknown> : null;
  const thinking = typeof details?.reasoning === "string" ? details.reasoning : null;
  const reply = typeof details?.text === "string" ? details.text : null;
  const rest = details ? Object.fromEntries(Object.entries(details).filter(([key]) => !(key === "reasoning" && thinking) && !(key === "text" && reply))) : entry.details;
  return <li>
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} className="flex w-full items-start gap-3 px-3 py-2.5 text-left text-sm hover:bg-muted/60">
      <ChevronRight className={`mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} aria-hidden="true" />
      <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium uppercase ${LEVEL_STYLE[entry.level]}`}>{entry.level}</span>
      <span className="min-w-0 flex-1">
        <span className="block break-words">{entry.message}</span>
        <span className="block text-xs text-muted-foreground">{time} · {LOG_AREA_LABELS[entry.area]} · <span className="font-mono">{entry.event}</span>{entry.audio_path ? " · audio" : ""}</span>
      </span>
    </button>
    {open && <div className="space-y-3 border-t border-border bg-muted/30 px-3 py-3 text-sm sm:pl-10">
      {entry.audio_path && <audio controls preload="none" src={`/api/logs/audio/${entry.id}`} className="w-full max-w-md">Your browser cannot play this recording.</audio>}
      {thinking && <div><p className="text-xs font-medium text-muted-foreground">Thinking</p><p className="mt-1 whitespace-pre-wrap break-words rounded-md border border-border bg-background p-2 italic">{thinking}</p></div>}
      {reply && <div><p className="text-xs font-medium text-muted-foreground">Reply</p><p className="mt-1 whitespace-pre-wrap break-words rounded-md border border-border bg-background p-2">{reply}</p></div>}
      <Links entry={entry} />
      {rest !== null && rest !== undefined && <div><p className="text-xs font-medium text-muted-foreground">Details</p>
        <pre className="mt-1 max-h-96 overflow-auto rounded-md border border-border bg-background p-2 font-mono text-xs">{JSON.stringify(rest, null, 2)}</pre></div>}
    </div>}
  </li>;
}

function Links({ entry }: { entry: LogEntryView }) {
  const items = [
    entry.conversation_id && <Link key="c" href={`/ai?conversation=${entry.conversation_id}`} className="underline hover:text-foreground">Open conversation</Link>,
    entry.agent_run_id && <Link key="a" href="/ai/activity" className="underline hover:text-foreground">Agent run {entry.agent_run_id.slice(0, 8)}</Link>,
    entry.usage_id && <Link key="u" href="/settings/diagnostics#usage" className="underline hover:text-foreground">AI usage row <span className="font-mono">{entry.usage_id.slice(0, 8)}</span></Link>,
    entry.job_id && <span key="j">Job <span className="font-mono">{entry.job_id.slice(0, 8)}</span></span>,
  ].filter(Boolean);
  return items.length ? <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">{items}</p> : null;
}

type Report = { text: string; json: string; count: number; capped: boolean };

function LogTools({ filter, count }: { filter: LogFilter; count: number }) {
  const [report, setReport] = useState<Report | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleted, remove, deleting] = useActionState(deleteAllLogsSafely, {});

  async function preview() {
    setStatus("Preparing a redacted copy…");
    try {
      const response = await fetch(`/api/logs/report?${query(filter)}`);
      if (!response.ok) throw new Error("The report could not be prepared. Try again.");
      setReport(await response.json() as Report);
      setStatus(null);
    } catch (error) { setStatus(error instanceof Error ? error.message : "The report could not be prepared. Try again."); }
  }

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setStatus("Copied. Paste it into your bug report."); }
    catch { setStatus("Copying was blocked by the browser. Select the text and copy it, or download it."); }
  }

  const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
  return <div className="space-y-3">
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={() => void preview()} disabled={count === 0} className={button}><Copy className="size-4" aria-hidden="true" />Copy for a bug report</button>
      <button type="button" onClick={() => setConfirming(value => !value)} className={`${button} text-danger`}><Trash2 className="size-4" aria-hidden="true" />Delete all logs now</button>
    </div>
    {confirming && <form action={remove} className="flex flex-wrap items-end gap-2 rounded-lg border border-danger/40 p-3 text-sm">
      <label className="grid gap-1">Type DELETE to remove every log entry and recording. This cannot be undone.
        <input name="confirmation" autoComplete="off" className={control} /></label>
      <button type="submit" disabled={deleting} className={`${button} border-danger text-danger`}>{deleting ? "Deleting…" : "Delete all logs"}</button>
      {deleted.error && <p role="alert" className="w-full text-danger">{deleted.error}</p>}
    </form>}
    {status && <p role="status" className="text-sm text-muted-foreground">{status}</p>}
    {report && <div className="space-y-2 rounded-lg border border-border p-3">
      <p className="text-sm"><strong>Preview of exactly what will be copied</strong> · {report.count} entries{report.capped ? " (the newest ones; narrow the filter for older entries)" : ""}. Money amounts, IBANs, account numbers, names, emails, keys and chat text are replaced, and audio is left out.</p>
      <textarea readOnly value={report.text} aria-label="Redacted bug report" className="h-72 w-full rounded-md border border-border bg-background p-2 font-mono text-xs" />
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void copy(report.text)} className={button}><Copy className="size-4" aria-hidden="true" />Copy</button>
        <button type="button" onClick={() => save(`moneo-logs-${stamp}.txt`, report.text, "text/plain")} className={button}><Download className="size-4" aria-hidden="true" />Download .txt</button>
        <button type="button" onClick={() => save(`moneo-logs-${stamp}.json`, report.json, "application/json")} className={button}><Download className="size-4" aria-hidden="true" />Download .json</button>
        <button type="button" onClick={() => setReport(null)} className={button}>Close</button>
      </div>
    </div>}
  </div>;
}

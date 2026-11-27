"use client";
import { useEffect, useState, type ReactNode } from "react";
import type { holdingRows } from "@/lib/scalable/holding-rows";
import type { HoldingView } from "@/lib/scalable/holding-view";
import type { ValueHistoryView } from "@/lib/scalable/value-history";

export type HoldingRow = ReturnType<typeof holdingRows>[number];

const holdingDetail = () => import("@/components/scalable-holding-detail").then(({ ScalableHoldingDetail }) => (view: HoldingView) => <ScalableHoldingDetail view={view} />);
const portfolioHistory = () => import("@/components/scalable-value-history").then(({ ValueHistory }) => (view: ValueHistoryView) => <ValueHistory view={view} label="Scalable portfolio value by day" />);
const GAIN = { up: "text-success", down: "text-danger", flat: "text-muted-foreground" };

type State = { status: "loading" } | { status: "ready"; content: ReactNode } | { status: "error"; message: string };

function Loaded<T>({ url, view }: { url: string; view: () => Promise<(data: T) => ReactNode> }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([fetch(url, { cache: "no-store", signal: controller.signal }), view()])
      .then(async ([response, render]) => {
        const body = await response.json();
        setState(response.ok ? { status: "ready", content: render(body as T) } : { status: "error", message: (body as { error?: string }).error ?? "The history could not be loaded." });
      })
      .catch(() => { if (!controller.signal.aborted) setState({ status: "error", message: "The history could not be loaded." }); });
    return () => controller.abort();
  }, [url, view, attempt]);
  if (state.status === "loading") return <div role="status" className="space-y-2"><span className="sr-only">Loading history…</span><div className="h-36 w-full animate-pulse rounded bg-muted" /></div>;
  if (state.status === "error") return <div role="alert" className="text-sm"><p>{state.message}</p>
    <button type="button" onClick={() => { setState({ status: "loading" }); setAttempt(count => count + 1); }} className="min-h-11 font-medium text-brand underline">Try again</button></div>;
  return state.content;
}

function Disclosure({ label, summary, children }: { label: string; summary: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <li>
    <button type="button" aria-expanded={open} aria-label={label} onClick={() => setOpen(value => !value)} className="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted/50">
      <span aria-hidden="true" className={`text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}>›</span>{summary}</button>
    {open && <div className="border-t border-border px-3 py-4">{children}</div>}
  </li>;
}

export function ScalableHoldings({ holdings, version }: { holdings: HoldingRow[]; version: string }) {
  return <div className="space-y-1">
    <p className="text-xs text-muted-foreground">Open a row for its chart, table and trades.</p>
    <ul aria-label="Scalable holdings" className="-mx-1 divide-y divide-border rounded-lg border border-border">
      <Disclosure label="Portfolio value over time" summary={<span className="font-medium">Portfolio value over time</span>}>
        <Loaded key={version} url="/api/scalable/history" view={portfolioHistory} />
      </Disclosure>
      {holdings.map(holding => <Disclosure key={holding.id} label={`${holding.name}: history and details`} summary={<>
        <span className="min-w-0 flex-1"><span className="block truncate font-medium">{holding.name}</span><span className="block text-xs text-muted-foreground">{holding.position}</span></span>
        <span className="shrink-0 text-right"><span className="block font-mono tabular-nums">{holding.value}</span>
          {holding.gain && <span className={`block font-mono text-xs tabular-nums ${GAIN[holding.gain.direction]}`}>{holding.gain.text}</span>}</span>
      </>}>
        <Loaded key={version} url={`/api/scalable/holdings/${holding.id}`} view={holdingDetail} />
      </Disclosure>)}
    </ul>
  </div>;
}

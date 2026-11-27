"use client";
import dynamic from "next/dynamic";
import { useEffect, useState, type ReactNode } from "react";
import type { holdingRows } from "@/lib/scalable/holding-rows";
import type { HoldingView } from "@/lib/scalable/holding-view";
import type { ValueHistoryView } from "@/lib/scalable/value-history";

export type HoldingRow = ReturnType<typeof holdingRows>[number];

const loading = () => <div role="status" className="space-y-2"><span className="sr-only">Loading history…</span><div className="h-36 w-full animate-pulse rounded bg-muted" /></div>;
const HoldingDetail = dynamic(() => import("@/components/scalable-holding-detail").then(module => module.ScalableHoldingDetail), { loading });
const ValueHistory = dynamic(() => import("@/components/scalable-value-history").then(module => module.ValueHistory), { loading });
const GAIN = { up: "text-success", down: "text-danger", flat: "text-muted-foreground" };

type State<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; message: string };

function Loaded<T>({ url, children }: { url: string; children: (data: T) => ReactNode }) {
  const [state, setState] = useState<State<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const body = await response.json();
        setState(response.ok ? { status: "ready", data: body as T } : { status: "error", message: (body as { error?: string }).error ?? "The history could not be loaded." });
      })
      .catch(() => { if (!controller.signal.aborted) setState({ status: "error", message: "The history could not be loaded." }); });
    return () => controller.abort();
  }, [url, attempt]);
  if (state.status === "loading") return loading();
  if (state.status === "error") return <div role="alert" className="text-sm"><p>{state.message}</p>
    <button type="button" onClick={() => { setState({ status: "loading" }); setAttempt(count => count + 1); }} className="min-h-11 font-medium text-brand underline">Try again</button></div>;
  return children(state.data);
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
        <Loaded<ValueHistoryView> key={version} url="/api/scalable/history">{view => <ValueHistory view={view} label="Scalable portfolio value by day" />}</Loaded>
      </Disclosure>
      {holdings.map(holding => <Disclosure key={holding.id} label={`${holding.name}: history and details`} summary={<>
        <span className="min-w-0 flex-1"><span className="block truncate font-medium">{holding.name}</span><span className="block text-xs text-muted-foreground">{holding.position}</span></span>
        <span className="shrink-0 text-right"><span className="block font-mono tabular-nums">{holding.value}</span>
          {holding.gain && <span className={`block font-mono text-xs tabular-nums ${GAIN[holding.gain.direction]}`}>{holding.gain.text}</span>}</span>
      </>}>
        <Loaded<HoldingView> key={version} url={`/api/scalable/holdings/${holding.id}`}>{view => <HoldingDetail view={view} />}</Loaded>
      </Disclosure>)}
    </ul>
  </div>;
}

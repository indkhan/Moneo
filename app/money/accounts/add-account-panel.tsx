"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ConnectBank } from "@/components/connected-banks";
import { ConnectScalable } from "@/components/scalable-connection";

type Choice = "bank" | "scalable" | "manual";
const CHOICES: { id: Choice; label: string; detail: string }[] = [
  { id: "bank", label: "Connect a bank", detail: "Transactions and balances sync on their own" },
  { id: "scalable", label: "Connect Scalable", detail: "Holdings, cash and portfolio value" },
  { id: "manual", label: "Enter by hand", detail: "Type the balance yourself" },
];
const choiceClass = "flex min-h-12 w-full flex-col items-start rounded-lg px-3 py-2 text-left hover:bg-muted";

export function AddAccountPanel({ children }: { children: ReactNode }) {
  const panel = useRef<HTMLDetailsElement>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get("connect");
    if (wanted === "scalable" && panel.current) { panel.current.open = true; setChoice("scalable"); }
  }, []);
  const close = () => { if (panel.current) panel.current.open = false; setChoice(null); panel.current?.querySelector("summary")?.focus(); };
  return <details ref={panel} className="group" onToggle={event => { if (!event.currentTarget.open) setChoice(null); }}
    onKeyDown={event => { if (event.key === "Escape") close(); }} onClick={event => { if ((event.target as HTMLElement).closest("[data-close]")) close(); }}>
    <summary className="inline-flex h-11 cursor-pointer list-none items-center rounded-xl bg-primary px-4 text-[13px] font-medium text-primary-foreground hover:opacity-90">Add account</summary>
    <div className="absolute right-0 z-10 mt-2 max-h-[80vh] w-[min(34rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-border bg-card p-3 shadow-lg">
      {choice === null ? <ul aria-label="Add account" className="grid gap-1">
        {CHOICES.slice(0, 2).map(item => <li key={item.id}><button type="button" className={choiceClass} onClick={() => setChoice(item.id)}>
          <span className="text-sm font-medium">{item.label}</span><span className="text-xs text-muted-foreground">{item.detail}</span></button></li>)}
        <li><Link href="/import" className={choiceClass}><span className="text-sm font-medium">Import a file</span><span className="text-xs text-muted-foreground">A CSV or Excel export from your bank</span></Link></li>
        {CHOICES.slice(2).map(item => <li key={item.id}><button type="button" className={choiceClass} onClick={() => setChoice(item.id)}>
          <span className="text-sm font-medium">{item.label}</span><span className="text-xs text-muted-foreground">{item.detail}</span></button></li>)}
      </ul> : <div className="space-y-3 p-1">
        <button type="button" className="text-xs text-muted-foreground hover:text-foreground hover:underline" onClick={() => setChoice(null)}>← All choices</button>
        {choice === "bank" ? <ConnectBank onCancel={close} /> : choice === "scalable" ? <ConnectScalable /> : children}
      </div>}
    </div>
  </details>;
}

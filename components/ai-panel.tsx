"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ASK_EVENT, type AskSeed } from "./ask-about";
import { Sparkle } from "lucide-react";
import { Kbd } from "./command-palette";

const AiPanelDialog = dynamic(() => import("./ai-panel-dialog").then(module => module.AiPanelDialog), {
  ssr: false,
  loading: () => <span role="status" className="text-xs text-muted-foreground">Opening assistant…</span>,
});

/** The header Ask bar: a typed question opens the assistant panel with it drafted; the user still sends it. */
export function AiPanel({ onPalette }: { onPalette?: () => void }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [seed, setSeed] = useState<(AskSeed & { nonce: number }) | null>(null);
  useEffect(() => {
    const listener = (event: Event) => { setSeed({ ...(event as CustomEvent<AskSeed>).detail, nonce: Date.now() }); setLoaded(true); setOpen(true); };
    window.addEventListener(ASK_EVENT, listener);
    return () => window.removeEventListener(ASK_EVENT, listener);
  }, []);
  // Lets the app shell make room for the open panel on wide screens.
  useEffect(() => {
    document.documentElement.toggleAttribute("data-ai-panel", open);
    return () => document.documentElement.removeAttribute("data-ai-panel");
  }, [open]);
  return <>
    <form role="search" aria-label="Ask Moneo" onSubmit={event => { event.preventDefault(); const input = event.currentTarget.elements.namedItem("q") as HTMLInputElement; setSeed({ question: input.value, nonce: Date.now() }); input.value = ""; setLoaded(true); setOpen(true); }}
      className="flex h-11 min-w-0 max-w-[620px] flex-1 items-center gap-2.5 rounded-xl border border-input bg-card pl-3.5 pr-2">
      <button type="button" onClick={() => { setLoaded(true); setOpen(!open); }} aria-expanded={open} aria-haspopup="dialog" aria-controls={loaded ? "moneo-ai-panel" : undefined} aria-label="Ask Moneo" title="Open or close the assistant" className="shrink-0 text-ai"><Sparkle className="size-4 fill-current" aria-hidden="true" /></button>
      <input name="q" aria-label="Question for Moneo" placeholder="Ask about your money — answers cite your data" autoComplete="off" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
      {onPalette && <button type="button" onClick={onPalette} aria-label="Open command palette" className="hidden gap-0.5 sm:flex"><Kbd>⌘</Kbd><Kbd>K</Kbd></button>}
    </form>
    {/* Portaled: the sticky header's backdrop blur would otherwise confine the fixed panel. */}
    {loaded && createPortal(<AiPanelDialog open={open} seed={seed} onClose={() => setOpen(false)} />, document.body)}
  </>;
}

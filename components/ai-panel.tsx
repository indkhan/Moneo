"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ASK_EVENT, type AskSeed } from "./ask-about";
import { Sparkles } from "lucide-react";

const AiPanelDialog = dynamic(() => import("./ai-panel-dialog").then(module => module.AiPanelDialog), {
  ssr: false,
  loading: () => <span role="status" className="text-xs text-muted-foreground">Opening assistant…</span>,
});

export function AiPanel() {
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
    <button type="button" onClick={() => { setLoaded(true); setOpen(!open); }} aria-expanded={open} aria-haspopup="dialog" aria-controls={loaded ? "moneo-ai-panel" : undefined} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90"><Sparkles className="size-4" aria-hidden="true" />Ask Moneo</button>
    {/* Portaled: the sticky header's backdrop blur would otherwise confine the fixed panel. */}
    {loaded && createPortal(<AiPanelDialog open={open} seed={seed} onClose={() => setOpen(false)} />, document.body)}
  </>;
}

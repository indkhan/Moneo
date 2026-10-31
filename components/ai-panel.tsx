"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ASK_EVENT, type AskSeed } from "./ask-about";
import { Sparkle } from "lucide-react";
import { cn } from "@/lib/utils";

const AiPanelDialog = dynamic(() => import("./ai-panel-dialog").then(module => module.AiPanelDialog), {
  ssr: false,
  loading: () => <span role="status" className="text-xs text-muted-foreground">Opening assistant…</span>,
});

/** The header button that opens the assistant panel; questions from the command palette arrive as seeds and the user still sends them. */
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
    <button type="button" onClick={() => { setLoaded(true); setOpen(!open); }} aria-expanded={open} aria-haspopup="dialog" aria-controls={loaded ? "moneo-ai-panel" : undefined} aria-label="Ask Moneo" title="Open or close the assistant"
      className={cn("flex size-11 shrink-0 items-center justify-center rounded-xl border border-input text-ai hover:bg-muted", open && "bg-muted")}><Sparkle className="size-[18px] fill-current" aria-hidden="true" /></button>
    {/* Portaled: the sticky header's backdrop blur would otherwise confine the fixed panel. */}
    {loaded && createPortal(<AiPanelDialog open={open} seed={seed} onClose={() => setOpen(false)} />, document.body)}
  </>;
}

"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { Sparkles } from "lucide-react";

const AiPanelDialog = dynamic(() => import("./ai-panel-dialog").then(module => module.AiPanelDialog), {
  ssr: false,
  loading: () => <span role="status" className="text-xs text-muted-foreground">Opening assistant…</span>,
});

export function AiPanel() {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  return <>
    <button type="button" onClick={() => { setLoaded(true); setOpen(!open); }} aria-expanded={open} aria-haspopup="dialog" aria-controls={loaded ? "moneo-ai-panel" : undefined} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90"><Sparkles className="size-4" aria-hidden="true" />Ask Moneo</button>
    {loaded && <AiPanelDialog open={open} onClose={() => setOpen(false)} />}
  </>;
}

"use client";

import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { ChevronDown } from "lucide-react";

export function useDismissDetails(ref: RefObject<HTMLDetailsElement | null>) {
  useEffect(() => {
    const close = (event: Event) => {
      const details = ref.current;
      if (!details?.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape" || event.defaultPrevented || details.querySelector("details[open]")) return;
        event.preventDefault();
        details.open = false;
        if (details.contains(document.activeElement)) details.querySelector("summary")?.focus();
        return;
      }
      if (!details.contains(event.target as Node)) details.open = false;
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", close); };
  }, [ref]);
}

export function DetailsMenu({ label, summary, className = "relative", summaryClassName, panelClassName, children }: { label?: string; summary: ReactNode; className?: string; summaryClassName: string; panelClassName: string; children: ReactNode }) {
  const menu = useRef<HTMLDetailsElement>(null);
  useDismissDetails(menu);
  return <details ref={menu} className={className}>
    <summary aria-label={label} className={`cursor-pointer list-none [&::-webkit-details-marker]:hidden ${summaryClassName}`}>{summary}</summary>
    <div onClick={event => { if ((event.target as HTMLElement).closest("a, button")) menu.current?.removeAttribute("open"); }} className={panelClassName}>{children}</div>
  </details>;
}

export function BarMenu({ label, summary, children }: { label?: string; summary: ReactNode; children: ReactNode }) {
  return <DetailsMenu label={label} summary={<>{summary}<ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" /></>}
    summaryClassName="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 py-1 hover:bg-muted"
    panelClassName="absolute right-0 top-full z-20 mt-1 grid min-w-44 gap-0.5 rounded-lg border border-border bg-card p-1 text-xs shadow-lg">{children}</DetailsMenu>;
}

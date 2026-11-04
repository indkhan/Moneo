"use client";

import { useRef, type ReactNode } from "react";

/** The Add account disclosure: Escape or Cancel closes it and returns focus to its button. */
export function AddAccountPanel({ children }: { children: ReactNode }) {
  const panel = useRef<HTMLDetailsElement>(null);
  const close = () => { if (panel.current) panel.current.open = false; panel.current?.querySelector("summary")?.focus(); };
  return <details ref={panel} className="group relative" onKeyDown={event => { if (event.key === "Escape") close(); }} onClick={event => { if ((event.target as HTMLElement).closest("[data-close]")) close(); }}>
    <summary className="inline-flex h-11 cursor-pointer list-none items-center rounded-xl bg-primary px-4 text-[13px] font-medium text-primary-foreground hover:opacity-90">Add account</summary>
    {children}
  </details>;
}

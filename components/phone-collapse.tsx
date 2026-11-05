"use client";

import { useState, type ReactNode } from "react";

/** Folded behind a button on phones, where it would push the content off the first screen; always shown from md up. */
export function PhoneCollapse({ label, open: initial = false, children }: { label: string; open?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(initial);
  return <div className="space-y-2">
    <button type="button" aria-expanded={open} onClick={() => setOpen(current => !current)} className="min-h-11 rounded-[10px] border border-input px-3 text-[13px] hover:bg-muted md:hidden">{label}</button>
    <div className={open ? "" : "max-md:hidden"}>{children}</div>
  </div>;
}

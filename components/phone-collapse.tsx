"use client";

import { useState, type ReactNode } from "react";

export function PhoneCollapse({ label, open: initial = false, children }: { label: string; open?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(initial);
  return <div className="space-y-2">
    <button type="button" aria-expanded={open} onClick={() => setOpen(current => !current)} className="min-h-11 rounded-[10px] border border-input px-3 text-[13px] hover:bg-muted md:hidden">{label}</button>
    <div className={open ? "" : "max-md:hidden"}>{children}</div>
  </div>;
}

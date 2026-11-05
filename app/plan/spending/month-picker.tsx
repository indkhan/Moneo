"use client";

import { useRef } from "react";

/** Changing the month opens it; the short wait lets someone finish typing a year first. */
export function MonthPicker({ month, className }: { month: string; className: string }) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  return <form method="get" className="flex flex-wrap items-end gap-2">
    <label className="grid gap-1 text-xs font-medium text-muted-foreground">Calendar month
      <input type="month" name="month" defaultValue={month} required className={className} onChange={event => {
        const { form, value } = event.currentTarget;
        clearTimeout(timer.current);
        if (value) timer.current = setTimeout(() => form?.requestSubmit(), 400);
      }} />
    </label>
    <noscript><button className="min-h-10 rounded-xl border border-input px-4 text-[13px]">View month</button></noscript>
  </form>;
}

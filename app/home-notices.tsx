"use client";

import Link from "next/link";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTimeout } from "@/lib/use-timeout";

export type HomeNotice = { text: string; href: string; action: string };

const WAIT_MS = 15_000, SHOW_MS = 10_000, SEEN_KEY = "moneo-seen-notices";

export function nextNotices(notices: HomeNotice[], seen: string[]) {
  const fresh = notices.filter(notice => !seen.includes(notice.text));
  return { fresh, seen: notices.map(notice => notice.text) };
}

function readSeen(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter(item => typeof item === "string") : [];
  } catch { return []; }
}
function writeSeen(seen: string[]) {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch {}
}

export function HomeNotices({ notices }: { notices: HomeNotice[] }) {
  const [shown, setShown] = useState<HomeNotice[]>([]);
  const signature = JSON.stringify(notices);
  useEffect(() => {
    const texts = (JSON.parse(signature) as HomeNotice[]).map(notice => notice.text);
    writeSeen(readSeen().filter(text => texts.includes(text)));
  }, [signature]);
  useTimeout(() => {
    const { fresh, seen } = nextNotices(JSON.parse(signature), readSeen());
    if (!fresh.length) return;
    writeSeen(seen);
    setShown(fresh);
  }, WAIT_MS, signature);
  useTimeout(() => setShown([]), shown.length ? SHOW_MS : null, shown);
  if (!shown.length) return null;
  return <div role="status" className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] right-4 z-50 flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2 lg:bottom-6 lg:right-6">
    {shown.map(notice => <div key={notice.text} className="flex items-start gap-1 rounded-xl border border-border bg-card py-1 pl-4 pr-1 text-sm shadow-lg">
      <p className="min-w-0 flex-1 py-2"><span className="line-clamp-4">{notice.text}</span> <Link href={notice.href} className="font-medium text-brand underline">{notice.action}</Link></p>
      <button type="button" aria-label="Dismiss" onClick={() => setShown(rows => rows.filter(row => row !== notice))} className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground"><X className="size-4" aria-hidden /></button>
    </div>)}
  </div>;
}

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

export function ApplicationUpdateNotice() {
  const [tag, setTag] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const response = await fetch("/api/application/update-notice", { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) return;
        const result = await response.json();
        if (active) setTag(typeof result.tag === "string" ? result.tag : null);
      } catch { /* Update notices never block offline use. */ }
    };
    void check();
    const timer = setInterval(check, 3_600_000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  if (!tag || dismissed === tag) return null;
  return <div role="status" className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted px-4 py-2 text-sm sm:px-6 lg:px-8">
    <Link href="/settings#application" className="underline">Moneo {tag} is available. See update.</Link>
    <button type="button" className="min-h-10 rounded-md px-3 hover:bg-card" onClick={() => setDismissed(tag)}>Later</button>
  </div>;
}

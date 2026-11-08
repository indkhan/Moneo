"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

// A request that fails before reaching any bank has no connection to record it on, so it reports here.
export async function syncIfVisible(refresh: () => void, failed: () => void = () => {}) {
  if (document.visibilityState !== "visible") return;
  const response = await fetch("/api/sync/open", { method: "POST" }).catch(() => null);
  if (!response?.ok) return failed();
  if ((await response.json()).refresh) refresh();
}

const SHOW_MS = 10_000;

/** Syncs when Moneo is opened or returned to, and updates the page once fresher numbers land. Renders only when the request itself failed. */
export function SyncOnOpen() {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!failed) return;
    const hide = setTimeout(() => setFailed(false), SHOW_MS);
    return () => clearTimeout(hide);
  }, [failed]);
  useEffect(() => {
    const sync = () => void syncIfVisible(router.refresh, () => setFailed(true));
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [router]);
  if (!failed) return null;
  return <p role="status" className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] right-4 z-50 max-w-sm rounded-xl border border-border bg-card px-4 py-3 text-sm shadow-lg lg:bottom-6 lg:right-6">Moneo couldn&apos;t check for new numbers, so these are the last saved ones.</p>;
}

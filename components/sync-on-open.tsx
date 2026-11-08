"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export async function syncIfVisible(refresh: () => void) {
  if (document.visibilityState !== "visible") return;
  const response = await fetch("/api/sync/open", { method: "POST" }).catch(() => null);
  if (response?.ok && (await response.json()).refresh) refresh();
}

/** Syncs when Moneo is opened or returned to, and updates the page once fresher numbers land. Renders nothing. */
export function SyncOnOpen() {
  const router = useRouter();
  useEffect(() => {
    const sync = () => void syncIfVisible(router.refresh);
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [router]);
  return null;
}

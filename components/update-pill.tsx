"use client";

import { useState } from "react";
import { ArrowUpCircle } from "lucide-react";
import type { AppUpdate } from "@/lib/app-update";
import { usePolling } from "@/lib/use-polling";

const WHILE_UPDATING_MS = 1_000, OTHERWISE_MS = 60 * 60_000;

export function useAppUpdate(active: boolean) {
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  const working = update?.kind === "desktop" && (update.state === "downloading" || update.state === "installing");
  usePolling(async signal => {
    const response = await fetch("/api/app-update", { signal });
    if (response.ok) setUpdate(((await response.json()) as { update: AppUpdate | null }).update);
  }, working ? WHILE_UPDATING_MS : OTHERWISE_MS, active, { immediate: true });
  return { update, setUpdate };
}

export function UpdatePill({ update, onClick }: { update: AppUpdate | null; onClick: () => void }) {
  if (!update) return null;
  return <button type="button" onClick={onClick} aria-haspopup="dialog" title={`Moneo ${update.latest} is available`}
    className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-lime px-3 text-[13px] font-semibold text-[#0f1011] hover:opacity-90">
    <ArrowUpCircle className="size-4" strokeWidth={1.8} aria-hidden="true" />Update
  </button>;
}

"use client";

import { useRouter } from "next/navigation";
import { usePolling } from "@/lib/ai/use-polling";

/** Re-renders a server page every few seconds while what it shows is still running. Renders nothing. */
export function AutoRefresh({ everyMs = 5000 }: { everyMs?: number }) {
  const router = useRouter();
  usePolling(() => router.refresh(), everyMs, true);
  return null;
}

"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Re-renders the current page's server data once, then renders nothing. */
export function RefreshPage() {
  const router = useRouter();
  useEffect(() => { router.refresh(); }, [router]);
  return null;
}

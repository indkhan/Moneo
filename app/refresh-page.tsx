"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function RefreshPage() {
  const router = useRouter();
  useEffect(() => { router.refresh(); }, [router]);
  return null;
}

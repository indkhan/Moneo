"use client";

import { useEffect, useState } from "react";

export type AiAccessState = { ai: boolean; voice: boolean };

/** What AI the owner has set up, or null while loading (or when it can't be read, so nothing is blocked). */
export function useAiAccess() {
  const [access, setAccess] = useState<AiAccessState | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/ai/status", { cache: "no-store", signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(body => { if (body && typeof body.ai === "boolean" && typeof body.voice === "boolean") setAccess({ ai: body.ai, voice: body.voice }); })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  return access;
}

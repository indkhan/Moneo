"use client";

import { useEffect, useState } from "react";

const aiStaysHiddenWhileStatusIsUnknown = () => undefined;

export type AiAccessState = { ai: boolean; voice: boolean };

export function useAiAccess() {
  const [access, setAccess] = useState<AiAccessState | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/ai/status", { cache: "no-store", signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(body => { if (body && typeof body.ai === "boolean" && typeof body.voice === "boolean") setAccess({ ai: body.ai, voice: body.voice }); })
      .catch(aiStaysHiddenWhileStatusIsUnknown);
    return () => controller.abort();
  }, []);
  return access;
}

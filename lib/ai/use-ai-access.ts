"use client";

import { useEffect, useState } from "react";

const aiStaysHiddenWhileStatusIsUnknown = () => undefined;

export type AiAccessState = { ai: boolean; voice: boolean; models: string[]; chatModel: string | null };

let pending: Promise<AiAccessState | null> | null = null;

function readAccess() {
  pending ??= fetch("/api/ai/status", { cache: "no-store" })
    .then(response => response.ok ? response.json() : null)
    .then(body => body && typeof body.ai === "boolean" && typeof body.voice === "boolean" ? { ai: body.ai, voice: body.voice,
      models: Array.isArray(body.models) ? body.models.filter((model: unknown): model is string => typeof model === "string") : [], chatModel: typeof body.chatModel === "string" ? body.chatModel : null } : null)
    .finally(() => { pending = null; });
  return pending;
}

export function useAiAccess() {
  const [access, setAccess] = useState<AiAccessState | null>(null);
  useEffect(() => {
    let subscribed = true;
    readAccess()
      .then(access => { if (subscribed) setAccess(access); })
      .catch(aiStaysHiddenWhileStatusIsUnknown);
    return () => { subscribed = false; };
  }, []);
  return access;
}

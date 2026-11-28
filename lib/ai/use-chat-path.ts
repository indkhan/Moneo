"use client";

import { useMemo, useState } from "react";
import { picksTo, visiblePath, type ChatNode, type ChatPicks } from "./chat-tree";

export function useChatPath(requests: ChatNode[], shownEnd: string | null = null) {
  const [picks, setPicks] = useState<ChatPicks>(() => picksTo(requests, shownEnd));
  const path = useMemo(() => visiblePath(requests, picks), [requests, picks]);
  return { path, end: path.at(-1)?.answer ?? null, pick: (key: string, id: string) => setPicks(current => ({ ...current, [key]: id })) };
}

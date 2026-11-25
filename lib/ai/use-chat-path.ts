"use client";

import { useMemo, useState } from "react";
import { visiblePath, type ChatNode, type ChatPicks } from "./chat-tree";

export function useChatPath(requests: ChatNode[]) {
  const [picks, setPicks] = useState<ChatPicks>({});
  const path = useMemo(() => visiblePath(requests, picks), [requests, picks]);
  return { path, end: path.at(-1)?.answer ?? null, pick: (key: string, id: string) => setPicks(current => ({ ...current, [key]: id })) };
}

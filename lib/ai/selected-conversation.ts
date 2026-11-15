"use client";
import { useEffect } from "react";

export const SELECTION_IDLE_SECONDS = 30 * 60;

export function selectConversation(key: string, id: string, notify = true) {
  document.cookie = `${key}=${encodeURIComponent(id)}; Path=/; Max-Age=${SELECTION_IDLE_SECONDS}; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
  if (notify) window.dispatchEvent(new Event("moneo-conversation-change"));
}

export function ConversationSelection({ selectionKey, id }: { selectionKey: string; id: string }) {
  useEffect(() => { selectConversation(selectionKey, id); }, [selectionKey, id]);
  return null;
}

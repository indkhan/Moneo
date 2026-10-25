"use client";
import { useEffect } from "react";

/** Session cookie: the open chat resumes in this browser session only; a new session starts on an empty chat. */
export function selectConversation(key: string, id: string, notify = true) {
  document.cookie = `${key}=${encodeURIComponent(id)}; Path=/; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
  if (notify) window.dispatchEvent(new Event("moneo-conversation-change"));
}

export function ConversationSelection({ selectionKey, id }: { selectionKey: string; id: string }) {
  useEffect(() => { selectConversation(selectionKey, id); }, [selectionKey, id]);
  return null;
}

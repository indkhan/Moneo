"use client";
import { useEffect } from "react";

export function selectConversation(key: string, id: string, notify = true) {
  document.cookie = `${key}=${encodeURIComponent(id)}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
  if (notify) window.dispatchEvent(new Event("moneo-conversation-change"));
}

export function ConversationSelection({ selectionKey, id }: { selectionKey: string; id: string }) {
  useEffect(() => { selectConversation(selectionKey, id); }, [selectionKey, id]);
  return null;
}

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { attachmentId, attachmentSchema, isImage, type ChatAttachment } from "@/lib/ai/chat-attachments";
import type { ExtractedDocument } from "./extract";

const CACHE_SIZE = 24;
const cache = new Map<string, Promise<ExtractedDocument>>();

export async function downloadAttachment(supabase: SupabaseClient, file: ChatAttachment) {
  const { data, error } = await supabase.storage.from("chat").download(file.path);
  if (error || !data) throw new Error(`Could not read ${file.name}`);
  return new Uint8Array(await data.arrayBuffer());
}

export const isDocument = (file: ChatAttachment) => !isImage(file.type);

export function documentText(supabase: SupabaseClient, file: ChatAttachment, bytes?: Uint8Array): Promise<ExtractedDocument> {
  const cached = cache.get(file.path);
  if (cached) { cache.delete(file.path); cache.set(file.path, cached); return cached; }
  const pending = Promise.all([import("./extract"), bytes ?? downloadAttachment(supabase, file)])
    .then(([{ extractDocument }, data]) => extractDocument(data, file.type));
  cache.set(file.path, pending);
  pending.catch(() => cache.delete(file.path));
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return pending;
}

export async function conversationAttachments(supabase: SupabaseClient, workspaceId: string, conversationId: string): Promise<ChatAttachment[]> {
  const { data, error } = await supabase.from("messages").select("attachments").eq("workspace_id", workspaceId).eq("conversation_id", conversationId)
    .eq("role", "user").order("created_at", { ascending: true }).limit(1000);
  if (error) throw error;
  return (data ?? []).flatMap(row => z.array(attachmentSchema).safeParse(row.attachments).data ?? [])
    .filter(file => file.path.startsWith(`${workspaceId}/`));
}

export const findAttachment = (files: ChatAttachment[], reference: string) =>
  files.findLast(file => attachmentId(file.path) === reference.toLowerCase()) ?? files.findLast(file => file.name.toLowerCase() === reference.trim().toLowerCase());

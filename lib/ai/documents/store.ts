import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { attachmentId, attachmentSchema, type ChatAttachment } from "@/lib/ai/chat-attachments";
import { DOCUMENT_KINDS, extractDocument, type ExtractedDocument } from "./extract";

// Attached files never change (each upload gets a new random path), so extracted text is kept in memory by
// path: reopening a document later in the conversation does not download and parse it again.
const CACHE_SIZE = 24;
const cache = new Map<string, Promise<ExtractedDocument>>();

export async function downloadAttachment(supabase: SupabaseClient, file: ChatAttachment) {
  const { data, error } = await supabase.storage.from("chat").download(file.path);
  if (error || !data) throw new Error(`Could not read ${file.name}`);
  return new Uint8Array(await data.arrayBuffer());
}

export const isDocument = (file: ChatAttachment) => DOCUMENT_KINDS[file.type] !== undefined;

/** The file's extracted text, read once per path. `bytes` skips the download when the caller already has them. */
export function documentText(supabase: SupabaseClient, file: ChatAttachment, bytes?: Uint8Array): Promise<ExtractedDocument> {
  const cached = cache.get(file.path);
  if (cached) { cache.delete(file.path); cache.set(file.path, cached); return cached; }
  const pending = (async () => extractDocument(bytes ?? await downloadAttachment(supabase, file), file.type))();
  cache.set(file.path, pending);
  // A failed read is not kept, so a later try reads the file again.
  pending.catch(() => cache.delete(file.path));
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return pending;
}

/** Every file attached in a conversation, oldest first; citations and document_read only reach these. */
export async function conversationAttachments(supabase: SupabaseClient, workspaceId: string, conversationId: string): Promise<ChatAttachment[]> {
  const { data, error } = await supabase.from("messages").select("attachments").eq("workspace_id", workspaceId).eq("conversation_id", conversationId)
    .eq("role", "user").order("created_at", { ascending: true }).limit(1000);
  if (error) throw error;
  return (data ?? []).flatMap(row => z.array(attachmentSchema).safeParse(row.attachments).data ?? [])
    .filter(file => file.path.startsWith(`${workspaceId}/`));
}

/** A conversation's file by its short id (or, failing that, its exact name). */
export const findAttachment = (files: ChatAttachment[], reference: string) =>
  files.findLast(file => attachmentId(file.path) === reference.toLowerCase()) ?? files.findLast(file => file.name.toLowerCase() === reference.trim().toLowerCase());

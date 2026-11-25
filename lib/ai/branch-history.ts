import type { SupabaseClient } from "@supabase/supabase-js";
import { ancestors, type ChatNode } from "./chat-tree";

const SKELETON_LIMIT = 2000;
const REPLAYED_TURNS = 9;

export type BranchMessage = { role: string; content: string; context: unknown; attachments: unknown; request_id: string | null };

export async function chatSkeleton(supabase: SupabaseClient, workspace: string, conversation: string): Promise<ChatNode[]> {
  const { data, error } = await supabase.from("chat_requests").select("id,parent_id,regenerates,created_at").eq("workspace_id", workspace).eq("conversation_id", conversation)
    .order("created_at", { ascending: false }).limit(SKELETON_LIMIT);
  if (error) throw error;
  return (data ?? []).map(row => ({ id: row.id as string, parent: row.parent_id as string | null, regenerates: row.regenerates as string | null, created_at: row.created_at as string }));
}

export async function branchHistory(supabase: SupabaseClient, workspace: string, conversation: string, nodes: ChatNode[], leaf: string | null): Promise<BranchMessage[]> {
  const path = ancestors(nodes, leaf).slice(-REPLAYED_TURNS);
  if (!path.length) return [];
  const ids = [...new Set(path.flatMap(node => [node.id, node.regenerates ?? node.id]))];
  const { data, error } = await supabase.from("messages").select("role,content,context,attachments,request_id,reply_to,chat_request_id")
    .eq("workspace_id", workspace).eq("conversation_id", conversation).in("chat_request_id", ids).order("created_at");
  if (error) throw error;
  const rows = data ?? [];
  return path.flatMap(node => {
    const question = rows.filter(row => row.role === "user" && row.request_id === (node.regenerates ?? node.id));
    const steers = rows.filter(row => row.role === "user" && !row.request_id && row.chat_request_id === node.id);
    const answer = rows.filter(row => row.role === "assistant" && row.reply_to === node.id);
    return [...question, ...steers, ...answer].map(({ role, content, context, attachments, request_id }) => ({ role, content, context, attachments, request_id }));
  });
}

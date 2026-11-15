import type { SupabaseClient } from "@supabase/supabase-js";
import { organizationDescriptionKey } from "@/lib/import/organization";

export type SimilarRow = { id: string; version: number; description: string; category_id: string | null };

export async function similarRows(supabase: SupabaseClient, workspaceId: string, row: { id: string; description: string; category_id: string | null }) {
  const key = organizationDescriptionKey(row.description);
  if (key.length < 3 || !row.category_id) return { key, rows: [] as SimilarRow[] };
  const word = key.split(" ").reduce((longest, next) => next.length > longest.length ? next : longest);
  const { data, error } = await supabase.from("transactions").select("id, version, description, category_id").eq("workspace_id", workspaceId)
    .eq("status", "posted").eq("kind", "ordinary").neq("id", row.id).ilike("description", `%${word}%`).limit(2000);
  if (error) throw error;
  return { key, rows: (data as SimilarRow[]).filter(other => other.category_id !== row.category_id && organizationDescriptionKey(other.description) === key) };
}

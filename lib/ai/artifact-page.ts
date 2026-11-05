import type { SupabaseClient } from "@supabase/supabase-js";
import type { requireWorkspace } from "@/lib/auth";
import { renderCard } from "@/lib/cards/render";

export type PageVersion = { id: string; artifact_id: string; version: number; html: string | null; compiled: string | null; queries: unknown; params: unknown };

export async function loadPageVersion(supabase: SupabaseClient, workspaceId: string, artifactId: string, version?: number) {
  const query = supabase.from("artifact_versions").select("id, artifact_id, version, html, compiled, queries, params")
    .eq("workspace_id", workspaceId).eq("artifact_id", artifactId);
  const { data, error } = await (version ? query.eq("version", version) : query.order("version", { ascending: false }).limit(1)).maybeSingle();
  if (error) throw error;
  return data as PageVersion | null;
}

/** Generated Page code runs only in QuickJS; the browser receives the same checked tree as a Home card. */
export function renderPage(version: PageVersion, context: Awaited<ReturnType<typeof requireWorkspace>>, requested: Record<string, string | undefined> = {}) {
  return renderCard({ ...version, card_id: version.artifact_id, title: "", kind: "code", preset: null, compiled: version.compiled ?? "" }, context, { size: "XL", requested });
}

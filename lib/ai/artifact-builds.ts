import type { SupabaseClient } from "@supabase/supabase-js";

// The artifact route's maxDuration is 300 s; a build still "running" after this was cut off.
const RUN_WINDOW_MS = 6 * 60_000;
// A failed build stays listed this long, so someone who left the page still learns what happened.
const SHOWN_MS = 60 * 60_000;
export type ArtifactBuild = { id: string; prompt: string; status: "running" | "failed"; error: string | null; artifact_id: string | null };

/** Builds still running, or failed in the last hour, newest first; finished builds already show as artifacts. */
export async function loadArtifactBuilds(supabase: SupabaseClient, workspace: string, artifactId?: string): Promise<ArtifactBuild[]> {
  let query = supabase.from("artifact_builds").select("id,prompt,status,error,artifact_id,created_at").eq("workspace_id", workspace)
    .neq("status", "completed").gte("created_at", new Date(Date.now() - SHOWN_MS).toISOString());
  if (artifactId) query = query.eq("artifact_id", artifactId);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(10);
  if (error) return [];
  return (data as (ArtifactBuild & { created_at: string })[]).map(({ created_at, ...build }) =>
    build.status === "running" && Date.parse(created_at) < Date.now() - RUN_WINDOW_MS ? { ...build, status: "failed", error: "Stopped before it finished" } : build);
}

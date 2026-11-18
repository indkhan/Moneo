import type { SupabaseClient } from "@supabase/supabase-js";
import { readSettings, type WorkspaceSettings } from "@/lib/workspace-settings";

export * from "@/lib/workspace-settings";

export async function loadWorkspaceSettings(supabase: SupabaseClient, workspaceId: string): Promise<WorkspaceSettings> {
  const { data, error } = await supabase.from("workspace_settings").select("*").eq("workspace_id", workspaceId).maybeSingle();
  if (error) throw new Error("Workspace preferences unavailable");
  return readSettings(data);
}

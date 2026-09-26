import { createClient } from "@/lib/supabase/server";

export async function requireWorkspace() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error("Unauthorized");
  const { data: workspace, error } = await supabase
    .from("workspaces")
    .select("id, owner_id, display_currency")
    .eq("owner_id", user.id)
    .single();
  if (error || !workspace) throw new Error("Workspace unavailable");
  return { supabase, user, workspace };
}

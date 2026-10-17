import { cache } from "react";
import { createClient } from "@/lib/supabase-server";
import { settingsSchema } from "@/lib/settings";

// Memoized per request so the root layout and the page share one auth and workspace lookup.
export const requireWorkspace = cache(async () => {
  const supabase = await createClient();
  // getClaims verifies the JWT locally, so the RLS-scoped workspace read can run while
  // getUser still confirms the session with Supabase Auth before anything is returned.
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims.sub;
  if (!userId) throw new Error("Unauthorized");
  const [{ data: { user }, error: authError }, { data, error }] = await Promise.all([
    supabase.auth.getUser(),
    supabase.from("workspaces").select("id, owner_id, display_currency, workspace_settings(*)").eq("owner_id", userId).maybeSingle(),
  ]);
  if (authError || !user || user.id !== userId) throw new Error("Unauthorized");
  if (error || !data) throw new Error("Workspace unavailable");
  const { workspace_settings: stored, ...workspace } = data as typeof data & { workspace_settings: unknown };
  const settings = settingsSchema.parse(stored ?? {});
  return { supabase, user, settings, workspace: { ...workspace, timezone: settings.timezone, locale: settings.locale, settings } };
});

import { cache } from "react";
import { isAuthRetryableFetchError, type User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase-server";
import { settingsSchema } from "@/lib/settings";

// A session confirmed with Supabase Auth is trusted for a minute, so most navigations skip that
// round trip. Signing out here clears the cookie at once; a session revoked elsewhere stops
// working within the minute. Failed checks are never remembered.
const CONFIRMED_MS = 60_000;
const confirmed = new Map<string, { user: User; until: number }>();

async function confirmUser(supabase: Awaited<ReturnType<typeof createClient>>, userId: string, sessionId: string | undefined) {
  const key = sessionId ? `${userId}:${sessionId}` : null;
  const known = key ? confirmed.get(key) : undefined;
  if (known && known.until > Date.now()) return known.user;
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user || user.id !== userId) {
    console.warn("[workspace-access] user-confirmation-failed", { status: error?.status ?? null });
    if (key) confirmed.delete(key);
    // An auth outage (Moneo Desktop's GoTrue failing to open a connection) is not a signed-out owner.
    if (error && (isAuthRetryableFetchError(error) || (error.status ?? 0) >= 500)) throw new Error("Workspace unavailable");
    throw new Error("Unauthorized");
  }
  if (key) {
    if (confirmed.size >= 1000) confirmed.delete(confirmed.keys().next().value!);
    confirmed.set(key, { user, until: Date.now() + CONFIRMED_MS });
  }
  return user;
}

// Memoized per request so the root layout and the page share one auth and workspace lookup.
export const requireWorkspace = cache(async () => {
  const supabase = await createClient();
  // getClaims verifies the JWT locally, so the RLS-scoped workspace read can run while
  // the session is confirmed with Supabase Auth (or was within the last minute).
  const { data: claims, error: claimsError } = await supabase.auth.getClaims();
  const userId = claims?.claims.sub;
  if (!userId) {
    console.warn("[workspace-access] claims-unavailable", { status: claimsError?.status ?? null });
    throw new Error("Unauthorized");
  }
  const [user, { data, error }] = await Promise.all([
    confirmUser(supabase, userId, claims.claims.session_id),
    supabase.from("workspaces").select("id, owner_id, display_currency, workspace_settings(*)").eq("owner_id", userId).maybeSingle(),
  ]);
  if (error || !data) {
    console.warn("[workspace-access] workspace-unavailable", { queryFailed: !!error, workspaceMissing: !data });
    throw new Error("Workspace unavailable");
  }
  const { workspace_settings: stored, ...workspace } = data as typeof data & { workspace_settings: unknown };
  const parsed = settingsSchema.safeParse(stored ?? {});
  if (!parsed.success) {
    console.warn("[workspace-access] settings-invalid");
    throw new Error("Workspace settings unavailable");
  }
  const settings = parsed.data;
  return { supabase, user, settings, workspace: { ...workspace, timezone: settings.timezone, locale: settings.locale, settings } };
});

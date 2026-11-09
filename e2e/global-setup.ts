import type { FullConfig } from "@playwright/test";

// Refuses to start unless the server under test guards the owner's workspace: a test request with
// no session must be turned away (proxy.ts), never signed in as the owner. An older or foreign
// server on the port fails here before any spec runs.
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0].use.baseURL!;
  const response = await fetch(new URL("/api/health", baseURL), { headers: { "x-moneo-test": "1" } });
  if (response.status === 401) return;
  const health = response.ok ? await response.json() as { supabase?: boolean } : null;
  // No backend means there is no owner workspace to reach.
  if (health && !health.supabase) return;
  throw new Error(`${baseURL} would sign browser tests in as the owner. Stop that server and let Playwright start this checkout's app.`);
}

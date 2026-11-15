import type { FullConfig } from "@playwright/test";

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0].use.baseURL!;
  const response = await fetch(new URL("/api/health", baseURL), { headers: { "x-moneo-test": "1" } });
  if (response.status === 401) return;
  const health = response.ok ? await response.json() as { supabase?: boolean } : null;
  if (health && !health.supabase) return;
  throw new Error(`${baseURL} would sign browser tests in as the owner. Stop that server and let Playwright start this checkout's app.`);
}

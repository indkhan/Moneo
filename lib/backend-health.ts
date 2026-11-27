import "server-only";
import { serviceRoleConfig } from "@/lib/env";
import { serviceDb } from "@/lib/service-db";

export type ServiceCheck = { name: string; ok: boolean; ms: number };

const TIMEOUT_MS = 3000;

async function timed(name: string, check: () => Promise<boolean>): Promise<ServiceCheck> {
  const started = performance.now();
  const ok = await check().catch(serviceCountsAsDownWhenItCannotBeReached);
  return { name, ok, ms: Math.round(performance.now() - started) };
}

function serviceCountsAsDownWhenItCannotBeReached() {
  return false;
}

export async function backendHealth(): Promise<ServiceCheck[] | null> {
  const config = serviceRoleConfig();
  if (!config) return null;
  const reach = (path: string) => async () => {
    const response = await fetch(new URL(path, config.url), { headers: { apikey: config.key, Authorization: `Bearer ${config.key}` }, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
    return response.ok;
  };
  return Promise.all([
    timed("Database", async () => !(await serviceDb().from("workspaces").select("id").limit(1).abortSignal(AbortSignal.timeout(TIMEOUT_MS))).error),
    timed("Sign-in (Auth)", reach("/auth/v1/health")),
    timed("Data API (PostgREST)", reach("/rest/v1/")),
    timed("File storage", reach("/storage/v1/status")),
  ]);
}

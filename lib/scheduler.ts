import { cronSecret, loopbackUrl } from "@/lib/env";

export const CRON_JOBS = ["/api/cron/summaries", "/api/cron/reviews", "/api/cron/agent-backlog", "/api/cron/bank-sync", "/api/cron/scalable-sync", "/api/cron/scalable-history", "/api/cron/chat-titles"] as const;
const HOUR = 3_600_000, FIRST_RUN = 60_000;

export async function runCronJobs(baseUrl: string, secret: string, fetcher: typeof fetch = fetch) {
  for (const path of CRON_JOBS) {
    try {
      const response = await fetcher(new URL(path, baseUrl), { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(300_000) });
      if (!response.ok && response.status !== 503) console.warn(`Scheduled job ${path} returned ${response.status}`);
    } catch (error) {
      console.warn(`Scheduled job ${path} failed`, error instanceof Error ? error.message : error);
    }
  }
}

export function startScheduler(env?: NodeJS.ProcessEnv) {
  const secret = cronSecret(env);
  if (!secret) return null;
  const baseUrl = loopbackUrl(env);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runCronJobs(baseUrl, secret); } finally { running = false; }
  };
  const first = setTimeout(() => void tick(), FIRST_RUN);
  const hourly = setInterval(() => void tick(), HOUR);
  first.unref(); hourly.unref();
  return () => { clearTimeout(first); clearInterval(hourly); };
}

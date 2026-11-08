// Moneo runs its background jobs from the server process.
// Every job is safe to repeat: summaries and review recovery claim due work, and the syncs
// skip connections synced within the last day. Running hourly catches up after the
// computer was asleep or off.
export const CRON_JOBS = ["/api/cron/summaries", "/api/cron/reviews", "/api/cron/bank-sync", "/api/cron/scalable-sync", "/api/cron/scalable-history", "/api/cron/chat-titles"] as const;
const HOUR = 3_600_000, FIRST_RUN = 60_000;

export async function runCronJobs(baseUrl: string, secret: string, fetcher: typeof fetch = fetch) {
  // One at a time, so the syncs don't compete with the summaries for the database.
  for (const path of CRON_JOBS) {
    try {
      const response = await fetcher(new URL(path, baseUrl), { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(300_000) });
      // 503 means the feature isn't set up (no bank or Scalable keys); stay quiet about it.
      if (!response.ok && response.status !== 503) console.warn(`Scheduled job ${path} returned ${response.status}`);
    } catch (error) {
      console.warn(`Scheduled job ${path} failed`, error instanceof Error ? error.message : error);
    }
  }
}

export function startScheduler(env: NodeJS.ProcessEnv = process.env) {
  const secret = env.CRON_SECRET;
  if (!secret) return null;
  const baseUrl = `http://127.0.0.1:${env.PORT ?? 3000}`;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runCronJobs(baseUrl, secret); } finally { running = false; }
  };
  const first = setTimeout(tick, FIRST_RUN);
  const hourly = setInterval(tick, HOUR);
  first.unref(); hourly.unref();
  return () => { clearTimeout(first); clearInterval(hourly); };
}

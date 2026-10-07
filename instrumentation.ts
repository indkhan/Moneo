export async function register() {
  // Workflow's local port lookup reads a report; reverse DNS can block the event loop.
  if (process.env.NEXT_RUNTIME === "nodejs" && !process.env.VERCEL) {
    (process.report as NodeJS.ProcessReport & { excludeNetwork: boolean }).excludeNetwork = true;
    // Local queues are in memory; start replays persisted pending/running runs.
    // Next awaits this once per server instance. Vercel owns its durable queue.
    const { getWorld } = await import("workflow/runtime");
    await getWorld().start?.();
  }
}

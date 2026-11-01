export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Node closes idle connections after 4 s, so each page's burst of database reads paid for new TLS
    // handshakes (about 100 ms more). Keeping them open for a minute makes the next page reuse them.
    const { Agent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000 }));
  }
  // Workflow's local port lookup reads a report; reverse DNS can block the event loop.
  if (process.env.NEXT_RUNTIME === "nodejs" && !process.env.VERCEL) {
    (process.report as NodeJS.ProcessReport & { excludeNetwork: boolean }).excludeNetwork = true;
    // Local queues are in memory; start replays persisted pending/running runs.
    // Next awaits this once per server instance. Vercel owns its durable queue.
    const { getWorld } = await import("workflow/runtime");
    await getWorld().start?.();
  }
}

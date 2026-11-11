export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Node closes idle connections after 4 s, so each page's burst of database reads paid for new
  // handshakes. Keeping them open for a minute makes the next page reuse them.
  const { Agent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000 }));
  // Workflow's local port lookup reads a report; reverse DNS can block the event loop.
  (process.report as NodeJS.ProcessReport & { excludeNetwork: boolean }).excludeNetwork = true;
  // A private desktop data preview must not replay copied jobs or start automatic provider syncs.
  if (process.env.MONEO_DESKTOP === "1" && process.env.MONEO_DESKTOP_PREVIEW === "1") return;
  // Local queues are in memory; start replays persisted pending/running runs.
  // Next awaits this once per server instance.
  const { getWorld } = await import("workflow/runtime");
  await getWorld().start?.();
  // Background jobs: summaries, review recovery and bank/Scalable syncs.
  const { startScheduler } = await import("@/lib/scheduler");
  startScheduler();
  // https://localhost:3443, which Enable Banking accepts as the return address for real banks.
  const { startBankReturnListener } = await import("@/lib/bank/return-listener");
  startBankReturnListener();
}

export function register() {
  // Workflow's local port lookup reads a report; reverse DNS can block the event loop.
  if (process.env.NEXT_RUNTIME === "nodejs" && !process.env.VERCEL)
    (process.report as NodeJS.ProcessReport & { excludeNetwork: boolean }).excludeNetwork = true;
}

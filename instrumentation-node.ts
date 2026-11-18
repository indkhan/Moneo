import { isDesktopPreview } from "@/lib/env";

export async function startNodeRuntime() {
  const { Agent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000 }));
  (process.report as NodeJS.ProcessReport & { excludeNetwork: boolean }).excludeNetwork = true;
  if (isDesktopPreview()) return;
  const { getWorld } = await import("workflow/runtime");
  await getWorld().start?.();
  const { startScheduler } = await import("@/lib/scheduler");
  startScheduler();
  const { startBankReturnListener } = await import("@/lib/bank/return-listener");
  startBankReturnListener();
}

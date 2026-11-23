import { isDesktopPreview, isDesktopRuntime } from "@/lib/env";

type DesktopParent = { on(event: "message", listener: (message: { data: unknown }) => void): void };

export const DESKTOP_BACKEND_READY = "moneo:backend-ready";

export async function startNodeRuntime() {
  const { Agent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000 }));
  (process.report as NodeJS.ProcessReport & { excludeNetwork: boolean }).excludeNetwork = true;
  if (isDesktopPreview()) return;
  const desktop = (process as NodeJS.Process & { parentPort?: DesktopParent }).parentPort;
  if (!isDesktopRuntime() || !desktop) return startBackgroundWork();
  let released = false;
  desktop.on("message", message => {
    if (released || message.data !== DESKTOP_BACKEND_READY) return;
    released = true;
    startBackgroundWork().catch((error: unknown) => console.error("Background jobs did not start; they start with the next launch", error));
  });
}

async function startBackgroundWork() {
  const { getWorld } = await import("workflow/runtime");
  await getWorld().start?.();
  const { startScheduler } = await import("@/lib/scheduler");
  startScheduler();
  const { startBankReturnListener } = await import("@/lib/bank/return-listener");
  startBankReturnListener();
}

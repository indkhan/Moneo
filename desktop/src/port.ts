import { createServer } from "node:net";
import { log, readSettings, updateSettings } from "./paths";

// Phone access, Scalable's registered return address and a pending ChatGPT sign-in all name this
// port, so it stays the same from run to run. 3000 is left to source checkouts.
export const DEFAULT_PORT = 47300;

function listen(port: number) {
  return new Promise<number | null>(resolve => {
    const server = createServer();
    server.once("error", () => resolve(null));
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : null));
    });
  });
}

export async function choosePort() {
  const saved = readSettings().port;
  const wanted = saved ?? DEFAULT_PORT;
  if (await listen(wanted) === wanted) {
    if (!saved) updateSettings({ port: wanted });
    return wanted;
  }
  const free = await listen(0);
  if (!free) throw new Error("No free local port for Moneo.");
  // First run: adopt the free port for good. Later runs: borrow it, and try the usual one next time.
  if (!saved) updateSettings({ port: free });
  log(`Port ${wanted} is busy; using ${free}${saved ? " for this run" : ""}.`);
  return free;
}

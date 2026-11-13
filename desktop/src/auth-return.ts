import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

// The only pages a sign-in may return to: the connection results on Import and Settings.
const RETURN_PATH = /^\/(import\?(bank|scalable)=(connected|error|invalid)(#scalable)?|settings\?chatgpt=[A-Za-z0-9%._~-]{1,600}#ai-access)$/;

/**
 * A loopback address, secret to this launch, that Moneo's server calls when a sign-in in the system
 * browser finishes, so the result opens in the app window. Browsers cannot reach it: they do not know
 * the address, and their cross-site POSTs carry an Origin header, which is refused.
 */
export async function startAuthReturn(onReturn: (path: string) => Promise<void>) {
  const token = randomUUID();
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== `/${token}` || req.headers.origin) {
      res.writeHead(403).end(); return;
    }
    const path = req.headers["x-moneo-return"];
    if (typeof path !== "string" || !RETURN_PATH.test(path)) {
      res.writeHead(400).end(); return;
    }
    try { await onReturn(path); res.writeHead(204).end(); }
    catch { res.writeHead(503).end(); }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/${token}`,
    close: () => { server.close(); server.closeAllConnections(); },
  };
}

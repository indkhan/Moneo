import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import path from "node:path";
import { appUrl as defaultAppUrl } from "@/lib/env";

export const BANK_RETURN_PORT = 3443;
export const BANK_REDIRECT_URL = `https://localhost:${BANK_RETURN_PORT}/api/bank/callback`;
const CALLBACK = "/api/bank/callback";

export function certificatePaths(dir = process.env.MONEO_DATA_DIR ?? path.join(process.cwd(), ".data")) {
  return { key: path.join(dir, "localhost-key.pem"), cert: path.join(dir, "localhost.pem") };
}

export function forwardTarget(requestUrl: string, appUrl: string) {
  const url = new URL(requestUrl, "https://localhost");
  return url.pathname === CALLBACK ? new URL(`${CALLBACK}${url.search}`, appUrl).toString() : null;
}

export function startBankReturnListener(appUrl = defaultAppUrl()) {
  const files = certificatePaths();
  if (!existsSync(/*turbopackIgnore: true*/ files.key) || !existsSync(/*turbopackIgnore: true*/ files.cert)) return null;
  const tls = { key: readFileSync(/*turbopackIgnore: true*/ files.key), cert: readFileSync(/*turbopackIgnore: true*/ files.cert) };
  const server = createServer(tls, (request, response) => {
    const target = forwardTarget(request.url ?? "/", appUrl);
    response.writeHead(target ? 303 : 404, target ? { location: target, "cache-control": "no-store" } : {}).end();
  });
  server.on("error", error => console.warn(`Bank return listener on port ${BANK_RETURN_PORT} is off:`, error.message));
  server.listen(BANK_RETURN_PORT, "127.0.0.1");
  server.unref();
  return server;
}

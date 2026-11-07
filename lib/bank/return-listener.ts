import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import path from "node:path";

// Enable Banking production apps only accept https:// return addresses, and Moneo runs on
// http://localhost. This listener answers on https://localhost:3443 (a certificate trusted only on
// this computer, made by `npm run setup`) and sends the browser straight on to Moneo's callback.
// Nothing is stored here; the code is useless without the app's private key.
export const BANK_RETURN_PORT = 3443;
export const BANK_REDIRECT_URL = `https://localhost:${BANK_RETURN_PORT}/api/bank/callback`;
const CALLBACK = "/api/bank/callback";

export function certificatePaths(dir = path.join(process.cwd(), ".data")) {
  return { key: path.join(dir, "localhost-key.pem"), cert: path.join(dir, "localhost.pem") };
}

/** Where the browser goes next: Moneo's own callback with the bank's query, or nowhere. */
export function forwardTarget(requestUrl: string, appUrl: string) {
  const url = new URL(requestUrl, "https://localhost");
  return url.pathname === CALLBACK ? new URL(`${CALLBACK}${url.search}`, appUrl).toString() : null;
}

export function startBankReturnListener(appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000") {
  const files = certificatePaths();
  if (!existsSync(files.key) || !existsSync(files.cert)) return null;
  const server = createServer({ key: readFileSync(files.key), cert: readFileSync(files.cert) }, (request, response) => {
    const target = forwardTarget(request.url ?? "/", appUrl);
    response.writeHead(target ? 303 : 404, target ? { location: target, "cache-control": "no-store" } : {}).end();
  });
  server.on("error", error => console.warn(`Bank return listener on port ${BANK_RETURN_PORT} is off:`, error.message));
  server.listen(BANK_RETURN_PORT, "127.0.0.1");
  server.unref();
  return server;
}

// The one Supabase URL the app talks to, replacing docker/Caddyfile: /auth/v1 → GoTrue,
// /rest/v1 → PostgREST, /storage/v1 → Storage, with the prefix stripped. Bodies stream both ways.
import http from "node:http";
import type { AddressInfo } from "node:net";

export type Routes = { auth: number; rest: number; storage: number };

const PREFIXES: [string, keyof Routes][] = [["/auth/v1", "auth"], ["/rest/v1", "rest"], ["/storage/v1", "storage"]];
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade"];

export function startGateway(port: number, routes: Routes, log: (line: string) => void) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const match = PREFIXES.find(([prefix]) => url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`));
    if (!match) { res.writeHead(404).end(); return; }
    const [prefix, service] = match;
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    for (const name of HOP_BY_HOP) delete headers[name];
    const forwarded = req.headers["x-forwarded-for"];
    headers["x-forwarded-for"] = forwarded ? `${forwarded}, ${req.socket.remoteAddress}` : req.socket.remoteAddress;
    headers["x-forwarded-proto"] ??= "http";
    headers["x-forwarded-host"] ??= req.headers.host;
    const upstream = http.request({ host: "127.0.0.1", port: routes[service], method: req.method, path: url.slice(prefix.length) || "/", headers, agent }, upstreamRes => {
      const responseHeaders = { ...upstreamRes.headers };
      for (const name of HOP_BY_HOP) delete responseHeaders[name];
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, responseHeaders);
      upstreamRes.pipe(res);
      upstreamRes.once("error", () => res.destroy());
    });
    upstream.once("error", error => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ message: `${service} is not reachable`, error: error.message }));
      else res.destroy();
    });
    res.once("close", () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  });
  // Uploads up to Storage's 50 MB limit can take a while on slow disks.
  server.requestTimeout = 0;
  return new Promise<{ port: number; close(): Promise<void> }>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      log(`Gateway listening on 127.0.0.1:${(server.address() as AddressInfo).port}`);
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); agent.destroy(); }),
      });
    });
  });
}

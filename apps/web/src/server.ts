// E01-S01 minimal application slice: zero-dependency HTTP health/version
// surface. No UI, no auth, no database yet (S02/S03 own those). Only build
// metadata (release/gitSha from env) is ever reported; request headers,
// bodies and process env are never echoed.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type AppInfo = { name: "moneo-web"; release: string; gitSha: string };

export function appInfo(): AppInfo {
  return {
    name: "moneo-web",
    release: process.env["APP_RELEASE"] ?? "dev",
    gitSha: process.env["GIT_SHA"] ?? "unknown",
  };
}

function json(res: ServerResponse, status: number, body: unknown, allow?: string): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    ...(allow ? { Allow: allow } : {}),
  });
  res.end(payload);
}

function discard(req: IncomingMessage): void {
  // Discard an unread body so the socket can be reused. Call only on paths
  // that never read the body: attaching a "data" listener before the JSON
  // reader would consume the body and hang the reader waiting for "end".
  req.resume();
  req.on("error", () => {});
}

export type AuthDelegate = {
  handle: (req: import("node:http").IncomingMessage, res: ServerResponse, path: string, method: string, query: URLSearchParams) => Promise<boolean>;
};

export function createApp(auth?: AuthDelegate | null, tenancy?: AuthDelegate | null): Server {
  return createServer((req, res) => {
    const method = req.method ?? "GET";
    const rawUrl = req.url ?? "/";
    const path = rawUrl.split("?", 1)[0];
    const query = new URLSearchParams(rawUrl.includes("?") ? rawUrl.slice(rawUrl.indexOf("?") + 1) : "");
    void (async () => {
      try {
        if (path === "/auth/login" || path === "/auth/callback" || path === "/auth/logout" || path === "/api/me") {
          if (!auth) {
            discard(req);
            json(res, 503, { error: "auth_not_configured" });
            return;
          }
          if (await auth.handle(req, res, path, method, query)) return;
        }
        if (path === "/api/workspaces" || path === "/api/accounts" || path.startsWith("/api/accounts/") || path === "/api/commands/accounts.rename") {
          if (!tenancy) {
            discard(req);
            json(res, 503, { error: "tenancy_not_configured" });
            return;
          }
          if (await tenancy.handle(req, res, path, method, query)) return;
        }
        if (path === "/healthz" || path === "/readyz" || path === "/version") {
          discard(req);
          if (method !== "GET" && method !== "HEAD") {
            json(res, 405, { error: "method_not_allowed" }, "GET");
            return;
          }
          const info = appInfo();
          const body =
            path === "/readyz"
              ? { ready: true, checks: { build: "ok" }, ...info }
              : { status: "ok", ...info };
          if (method === "HEAD") {
            res.writeHead(200, {
              "Content-Type": "application/json; charset=utf-8",
              "X-Content-Type-Options": "nosniff",
              "X-Frame-Options": "DENY",
              "Referrer-Policy": "no-referrer",
            });
            res.end();
            return;
          }
          json(res, 200, body);
          return;
        }
        discard(req);
        json(res, 404, { error: "not_found" });
      } catch {
        // All request handling is fail-closed: an unexpected throw must not
        // leak detail or leave the socket hanging.
        try {
          if (!res.headersSent) json(res, 503, { error: "unavailable" });
          else res.destroy();
        } catch { /* socket already gone */ }
      }
    })();
  });
}

export async function listen(server: Server, port: number, host = "127.0.0.1"): Promise<string> {
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("E01-S01: could not bind app server.");
  return `http://${address.address === "::" ? "127.0.0.1" : address.address}:${address.port}`;
}

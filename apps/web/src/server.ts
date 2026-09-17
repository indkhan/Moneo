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
  handle: (req: import("node:http").IncomingMessage, res: ServerResponse, path: string, method: string, query: URLSearchParams, requestId?: string) => Promise<boolean>;
};

export type AppOptions = {
  ui?: AuthDelegate | null;
  controls?: import("./http-controls.ts").Controls | null;
  dbPing?: () => Promise<boolean>;
};

function wantsHtml(req: import("node:http").IncomingMessage): boolean {
  return (req.headers.accept ?? "").includes("text/html");
}

function htmlError(res: ServerResponse, status: number, heading: string, message: string, requestId: string): void {
  // Minimal negotiated shell for edge rejections; feature pages use ui/shell.
  const body = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${status} — Moneo</title></head><body><main><h1>${status}</h1><div role="alert"><h2>${heading}</h2><p>${message}</p></div><p>Request ${requestId}</p></main></body></html>
`;
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  });
  res.end(body);
}

export function createApp(auth?: AuthDelegate | null, tenancy?: AuthDelegate | null, options: AppOptions = {}): Server {
  return createServer((req, res) => {
    const method = req.method ?? "GET";
    const rawUrl = req.url ?? "/";
    const path = rawUrl.split("?", 1)[0];
    const query = new URLSearchParams(rawUrl.includes("?") ? rawUrl.slice(rawUrl.indexOf("?") + 1) : "");
    const controls = options.controls ?? null;
    const gate = controls ? controls.begin(req, res) : null;
    const requestId = gate ? gate.id : "uncontrolled";
    const finish = (status: number): void => {
      if (gate && controls) controls.finish(gate, method, rawUrl, status);
    };
    const origEnd = res.end.bind(res);
    // Capture the status for the redacted log line without touching bodies.
    (res as unknown as { end: (...args: unknown[]) => unknown }).end = (...args: unknown[]) => {
      finish(res.statusCode);
      return (origEnd as (...a: unknown[]) => unknown)(...args);
    };
    void (async () => {
      try {
        if (gate && gate.reject) {
          discard(req);
          if (wantsHtml(req)) {
            htmlError(res, gate.reject, gate.reject === 429 ? "Too many requests" : "Busy", gate.reject === 429 ? "Slow down and retry." : "Try again shortly.", requestId);
          } else {
            json(res, gate.reject, { error: gate.reject === 429 ? "rate_limited" : "unavailable" });
          }
          return;
        }
        if (path === "/auth/login" || path === "/auth/callback" || path === "/auth/logout" || path === "/api/me") {
          if (!auth) {
            discard(req);
            json(res, 503, { error: "auth_not_configured" });
            return;
          }
          if (await auth.handle(req, res, path, method, query, requestId)) return;
        }
        if (path === "/api/workspaces" || path === "/api/accounts" || path.startsWith("/api/accounts/") || path === "/api/commands/accounts.rename" || path.startsWith("/api/ai/")) {
          if (!tenancy) {
            discard(req);
            json(res, 503, { error: "tenancy_not_configured" });
            return;
          }
          if (await tenancy.handle(req, res, path, method, query, requestId)) return;
        }
        if (path === "/" || path === "/index.html" || path === "/w" || path.startsWith("/w/")) {
          if (options.ui) {
            if (await options.ui.handle(req, res, path, method, query, requestId)) return;
          }
        }
        if (path === "/healthz" || path === "/readyz" || path === "/version") {
          discard(req);
          if (method !== "GET" && method !== "HEAD") {
            json(res, 405, { error: "method_not_allowed" }, "GET");
            return;
          }
          const info = appInfo();
          let checks: Record<string, string> = { build: "ok" };
          let readyStatus = 200;
          if (path === "/readyz" && options.dbPing) {
            let dbOk = false;
            try {
              dbOk = await Promise.race([options.dbPing(), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000))]);
            } catch {
              dbOk = false;
            }
            checks = { ...checks, db: dbOk ? "ok" : "fail" };
            if (!dbOk) readyStatus = 503;
          }
          const body =
            path === "/readyz"
              ? { ready: readyStatus === 200, checks, ...info }
              : { status: "ok", ...info };
          if (method === "HEAD") {
            res.writeHead(path === "/readyz" ? readyStatus : 200, {
              "Content-Type": "application/json; charset=utf-8",
              "X-Content-Type-Options": "nosniff",
              "X-Frame-Options": "DENY",
              "Referrer-Policy": "no-referrer",
            });
            res.end();
            return;
          }
          json(res, path === "/readyz" ? readyStatus : 200, body);
          return;
        }
        discard(req);
        if (!options.ui && (path === "/" || path === "/index.html" || path === "/w" || path.startsWith("/w/"))) {
          json(res, 503, { error: "ui_not_configured" });
          return;
        }
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

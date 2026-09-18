// E01-S01 minimal application slice: zero-dependency HTTP health/version
// surface. No UI, no auth, no database yet (S02/S03 own those). Only build
// metadata (release/gitSha from env) is ever reported; request headers,
// bodies and process env are never echoed.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { escapeHtml } from "./ui/shell.ts";

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
  // Proper media-type check: comma-separated, case-insensitive, parameters
  // stripped (a bare substring match misfires on e.g. "text/html;q=0").
  return (req.headers.accept ?? "")
    .split(",")
    .map((part) => part.split(";", 1)[0].trim().toLowerCase())
    .includes("text/html");
}

function htmlError(res: ServerResponse, status: number, heading: string, message: string, requestId: string, retryAfterSec?: number): void {
  // Minimal negotiated shell for edge rejections; feature pages use ui/shell.
  // Escape everything interpolated: static today, enforced by construction.
  const body = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${status} — Moneo</title></head><body><main><h1>${status}</h1><div role="alert"><h2>${escapeHtml(heading)}</h2><p>${escapeHtml(message)}</p></div><p>Request ${escapeHtml(requestId)}</p></main></body></html>
`;
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    ...(retryAfterSec !== undefined ? { "Retry-After": String(retryAfterSec) } : {}),
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
    let finished = false;
    const finish = (status: number): void => {
      // Exactly once: double-end and destroy paths must not double-log or
      // double-release the in-flight slot.
      if (finished) return;
      finished = true;
      if (gate && controls) controls.finish(gate, method, rawUrl, status);
    };
    const origEnd = res.end.bind(res);
    // Capture the status for the redacted log line without touching bodies.
    (res as unknown as { end: (...args: unknown[]) => unknown }).end = (...args: unknown[]) => {
      finish(res.statusCode);
      return (origEnd as (...a: unknown[]) => unknown)(...args);
    };
    // Client aborts never call end(): release the in-flight slot on close.
    // finish() is once-guarded, so the normal end path is unaffected.
    res.on("close", () => finish(res.statusCode || 503));
    void (async () => {
      try {
        if (gate && gate.reject) {
          discard(req);
          const retryAfterSec = gate.retryAfterSec;
          if (wantsHtml(req)) {
            htmlError(res, gate.reject, gate.reject === 429 ? "Too many requests" : "Busy", gate.reject === 429 ? "Slow down and retry." : "Try again shortly.", requestId, retryAfterSec);
          } else {
            const body: Record<string, unknown> = { error: gate.reject === 429 ? "rate_limited" : "unavailable", requestId };
            const payload = `${JSON.stringify(body)}\n`;
            res.writeHead(gate.reject, {
              "Content-Type": "application/json; charset=utf-8",
              "Content-Length": Buffer.byteLength(payload),
              "X-Content-Type-Options": "nosniff",
              "X-Frame-Options": "DENY",
              "Referrer-Policy": "no-referrer",
              ...(retryAfterSec !== undefined ? { "Retry-After": String(retryAfterSec) } : {}),
            });
            res.end(payload);
          }
          return;
        }
        if (path === "/auth/login" || path === "/auth/callback" || path === "/auth/logout" || path === "/api/me") {
          if (!auth) {
            discard(req);
            json(res, 503, { error: "auth_not_configured", requestId });
            return;
          }
          if (await auth.handle(req, res, path, method, query, requestId)) return;
        }
        if (path === "/api/workspaces" || path.startsWith("/api/workspaces/") || path === "/api/accounts" || path.startsWith("/api/accounts/") || path === "/api/commands/accounts.rename" || path.startsWith("/api/ai/")) {
          if (!tenancy) {
            discard(req);
            json(res, 503, { error: "tenancy_not_configured", requestId });
            return;
          }
          if (await tenancy.handle(req, res, path, method, query, requestId)) return;
        }
        if (path === "/" || path === "/index.html" || path === "/w" || path.startsWith("/w/") || path === "/logout") {
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
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              const ping = options.dbPing();
              // Swallow the late settlement either way: after the race the
              // timeout is cleared and a late rejection must not surface as
              // an unhandled rejection.
              ping.catch(() => {});
              dbOk = await Promise.race([ping, new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), 3000)))]);
            } catch {
              dbOk = false;
            } finally {
              if (timer) clearTimeout(timer);
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
        if (!options.ui && (path === "/" || path === "/index.html" || path === "/w" || path.startsWith("/w/") || path === "/logout")) {
          json(res, 503, { error: "ui_not_configured", requestId });
          return;
        }
        json(res, 404, { error: "not_found" });
      } catch {
        // All request handling is fail-closed: an unexpected throw must not
        // leak detail or leave the socket hanging. The slot is always
        // released via finish(), even on the destroy path.
        try {
          if (!res.headersSent) json(res, 503, { error: "unavailable", requestId });
          else res.destroy();
        } catch { /* socket already gone */ }
        finally {
          finish(503);
        }
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

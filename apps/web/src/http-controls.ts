// E01-S06 edge controls: server-authoritative request ids, redacted request
// logging, per-IP rate limits and a global in-flight cap. Logs carry only
// id/method/pathname/status/ms — never query strings (callbacks carry codes),
// headers (cookies/tokens), bodies or subjects. Client-sent X-Request-Id is
// ignored (log-injection safe); the server id is echoed back and into error
// shells for correlation. Rate state is single-instance in-memory (documented
// pre-scale limitation); IP means socket IP only, never X-Forwarded-For.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export type LogLine = { id: string; method: string; path: string; status: number; ms: number };
export type Logger = (line: LogLine) => void;

export type ControlsConfig = {
  logger?: Logger;
  authWindowMs?: number;
  authMax?: number;
  mutatingWindowMs?: number;
  mutatingMax?: number;
  maxInflight?: number;
  clock?: () => number;
};

export type GateState = { id: string; started: number; admitted: boolean; reject?: 429 | 503; retryAfterSec?: number };

export type Controls = {
  begin: (req: IncomingMessage, res: ServerResponse) => GateState;
  finish: (state: GateState, method: string, path: string, status: number) => void;
};

function bucketOf(path: string, method: string): "auth" | "mutating" | "read" {
  if (path === "/auth/login" || path === "/auth/callback" || path === "/auth/logout" || path === "/api/me") return "auth";
  if (method !== "GET" && method !== "HEAD") return "mutating";
  return "read";
}

export function createControls(config: ControlsConfig = {}): Controls {
  const logger = config.logger ?? (() => {});
  const clock = config.clock ?? Date.now;
  const authWindow = config.authWindowMs ?? 60_000;
  // Degenerate max=0 would admit exactly one request per window; clamp to an
  // explicit closed state instead (callers wanting closed use maxInflight: 0,
  // which rejects everything deterministically).
  const authMax = Math.max(1, config.authMax ?? 30);
  const mutatingWindow = config.mutatingWindowMs ?? 60_000;
  const mutatingMax = Math.max(1, config.mutatingMax ?? 120);
  const maxInflight = Math.max(0, config.maxInflight ?? 128);
  const counts = new Map<string, { count: number; resetAt: number }>();
  let inflight = 0;

  return {
    begin(req, res) {
      // The id is assigned before any check so rejections are correlatable too.
      const id = randomUUID();
      const started = clock();
      try {
        res.setHeader("X-Request-Id", id);
      } catch { /* headers already sent; id still returned for logs */ }
      if (inflight >= maxInflight) return { id, started, admitted: false, reject: 503, retryAfterSec: 1 };
      const ip = req.socket.remoteAddress ?? "unknown";
      const rawUrl = req.url ?? "/";
      const path = rawUrl.split("?", 1)[0];
      const bucket = bucketOf(path, req.method ?? "GET");
      if (bucket !== "read") {
        const windowMs = bucket === "auth" ? authWindow : mutatingWindow;
        const max = bucket === "auth" ? authMax : mutatingMax;
        if (counts.size > 10_000) {
          const now = clock();
          for (const [key, entry] of counts) {
            if (entry.resetAt <= now) counts.delete(key);
          }
        }
        const key = `${ip}:${bucket}`;
        const now = clock();
        const entry = counts.get(key);
        if (!entry || entry.resetAt <= now) {
          counts.set(key, { count: 1, resetAt: now + windowMs });
        } else if (entry.count >= max) {
          return { id, started, admitted: false, reject: 429, retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
        } else {
          entry.count += 1;
        }
      }
      inflight += 1;
      return { id, started, admitted: true };
    },
    finish(state, method, rawPath, status) {
      if (state.admitted) inflight = Math.max(0, inflight - 1);
      const line: LogLine = { id: state.id, method, path: rawPath.split("?", 1)[0].slice(0, 200), status, ms: Math.max(0, clock() - state.started) };
      try {
        logger(line);
      } catch { /* logging must never break responses */ }
    },
  };
}

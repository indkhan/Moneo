// E04-S04 server-rendered chat UI: zero client JS, native keyboard semantics,
// sanitized markdown subset, explicit context, activity/evidence, Stop/retry.
// Consumes E04-S02/S03 APIs; no parallel data path.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { isUuid } from "../ids.ts";
import { renderMarkdown } from "../markdown.ts";
import {
  cancelTurn,
  createThread,
  getThread,
  listThreads,
  readActivity,
  retryTurn,
  sendTurn,
} from "../chat.ts";
import { sessionClaims, TenantDenied, TenantInvalid, type SessionResolver } from "../tenancy.ts";
import { listAccountViews } from "../commands/accounts.ts";
import { getFinancialSummary } from "../calculations/financial-summary.ts";
import { summarizeEligible } from "../ai-policy.ts";
import { readLimitedBody } from "../http-controls.ts";
import { errorPage, escapeHtml, page } from "./shell.ts";

export type ChatUiConfig = { appBaseUrl: string; sessionSecret: string };

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  });
  res.end(body);
}

function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  return readLimitedBody(req, 64 * 1024).then((body) => {
    try {
      return new URLSearchParams(body.toString("utf8"));
    } catch {
      throw new Error("body_invalid");
    }
  });
}

function sameOrigin(req: IncomingMessage, appBaseUrl: string): boolean {
  const allowed = new URL(appBaseUrl).origin;
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  if (typeof origin === "string") return origin === allowed;
  if (typeof referer === "string") return referer === allowed || referer.startsWith(`${allowed}/`);
  return false;
}

function fmtAmount(amountMinor: string, currency: string): string {
  try {
    const minor = BigInt(amountMinor);
    const sign = minor < 0n ? "-" : "";
    const abs = minor < 0n ? -minor : minor;
    const major = Number(abs) / 100;
    return `${sign}${major.toFixed(2)}`;
  } catch {
    return `${amountMinor} / 100`;
  }
}

function timeAgo(dateStr: string): string {
  const then = new Date(dateStr).getTime();
  const now = Date.now();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}d ago`;
}

function activityIcon(kind: string): string {
  switch (kind) {
    case "user-turn": return "U";
    case "assistant-queued": return "Q";
    case "assistant-running": return "R";
    case "assistant-published": return "P";
    case "assistant-interrupted": return "I";
    case "assistant-failed": return "F";
    case "assistant-cancelled": return "C";
    case "retry": return "T";
    default: return ".";
  }
}

function statusBadge(kind: string): string {
  const labels: Record<string, { label: string; class: string }> = {
    queued: { label: "Queued", class: "queued" },
    running: { label: "Running", class: "running" },
    completed: { label: "Completed", class: "completed" },
    interrupted: { label: "Interrupted", class: "interrupted" },
    failed: { label: "Failed", class: "failed" },
    cancelled: { label: "Cancelled", class: "cancelled" },
  };
  const s = labels[kind] ?? { label: kind, class: "" };
  return `<span class="badge ${s.class}">${s.label}</span>`;
}

function contextChip(label: string, removable = false): string {
  const rem = removable ? `<button type="submit" name="removeContext" value="" aria-label="Remove ${escapeHtml(label)}">x</button>` : "";
  return `<span class="context-chip">${escapeHtml(label)}${rem}</span>`;
}

export function createChatRouter(pool: Pool, resolveSession: SessionResolver, config: ChatUiConfig): {
  handle: (req: IncomingMessage, res: ServerResponse, path: string, method: string, query: URLSearchParams, requestId?: string) => Promise<boolean>;
} {
  async function shell(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    method: string,
    query: URLSearchParams,
    requestId = "uncontrolled",
  ): Promise<boolean> {
    if (method !== "POST") req.resume();
    req.on("error", () => {});

    // Helper to get workspaceId from /w/:workspaceId/... paths
    function getWorkspaceFromPath(path: string): string | null {
      const match = path.match(/^\/w\/([A-Za-z0-9-]+)/);
      return match ? match[1] : null;
    }

    const session = await resolveSession(req);
    const user = session ? { sub: session.keycloakSub } : null;

    // Chat routes under /w/:workspaceId/chat
    const workspaceId = getWorkspaceFromPath(path);
    if (!workspaceId) {
      // Not a workspace-scoped chat path
      return false;
    }
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.session) {
      html(res, 401, errorPage({ status: 401, heading: "Sign in required", message: "Log in to use chat.", back: "/", requestId, authed: false }));
      return true;
    }
    if (!resolved.claim) {
      html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
      return true;
    }
    const claims = resolved.claim;

    // Chat thread list: /w/:workspaceId/chat
    if (path === `/w/${workspaceId}/chat` && method === "GET") {
      const threads = await listThreads(pool, claims);
      const content = threads.length === 0
        ? `<p>No conversations yet.</p><p><a href="/w/${escapeHtml(workspaceId)}/chat/new">Start a new conversation</a></p>`
        : `<ul>${threads.map((t) => `<li><a href="/w/${escapeHtml(workspaceId)}/chat/${escapeHtml(t.id)}">${escapeHtml(t.title || "Untitled")}</a> - ${timeAgo(t.createdAt)}</li>`).join("")}</ul>`;
      html(res, 200, page({ title: "Conversations", requestId, authed: true, content: `<p><a href="/w/${escapeHtml(workspaceId)}/chat/new">New conversation</a></p>${content}` }));
      return true;
    }

    // New thread: /w/:workspaceId/chat/new
    if (path === `/w/${workspaceId}/chat/new` && method === "POST") {
      const form = await readFormBody(req).catch(() => null);
      const title = form?.get("title") ?? "";
      try {
        const thread = await createThread(pool, claims, claims.userId, { title });
        res.writeHead(303, { Location: `/w/${escapeHtml(workspaceId)}/chat/${thread.id}` });
        res.end();
        return true;
      } catch { /* fall through to error */ }
      html(res, 500, errorPage({ status: 500, heading: "Error", message: "Could not create conversation.", back: `/w/${escapeHtml(workspaceId)}/chat`, requestId, authed: true }));
      return true;
    }

    // Thread view: /w/:workspaceId/chat/:threadId
    const threadMatch = path.match(new RegExp(`^/w/${workspaceId}/chat/([A-Za-z0-9-]+)$`));
    if (threadMatch && method === "GET") {
      const threadId = threadMatch[1];
      try {
        const view = await getThread(pool, claims, threadId);
        if (!view) {
          html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such conversation.", back: `/w/${escapeHtml(workspaceId)}/chat`, requestId, authed: true }));
          return true;
        }
        const activity = await readActivity(pool, claims, threadId, 0, 50);
        const accounts = await listAccountViews(pool, claims);
        const [summary, eligible] = await Promise.all([
          getFinancialSummary(pool, claims, workspaceId),
          summarizeEligible(pool, claims),
        ]);
        const contextChips = [
          `Coverage: ${eligible.coverage}`,
          `Policy: v${eligible.policyVersion}`,
          `${eligible.accountCount} eligible accounts`,
        ];

        // Render turns
        const turnsHtml = view.turns.map((turn) => {
          const isUser = turn.role === "user";
          const badge = isUser ? "" : statusBadge(turn.status);
          const bodyHtml = isUser ? escapeHtml(turn.body) : renderMarkdown(turn.body);
          return `
            <article class="turn ${turn.role}">
              <header>
                <strong>${isUser ? "You" : "Assistant"}</strong>
                ${badge}
                <time datetime="${turn.createdAt}">${timeAgo(turn.createdAt)}</time>
              </header>
              <div class="turn-body">${bodyHtml}</div>
              ${!isUser && turn.status === "running" ? `
                <form method="post" action="/w/${escapeHtml(workspaceId)}/chat/${escapeHtml(threadId)}/stop" style="display:inline">
                  <button type="submit">Stop</button>
                </form>
              ` : ""}
              ${!isUser && (turn.status === "interrupted" || turn.status === "failed" || turn.status === "cancelled") ? `
                <form method="post" action="/w/${escapeHtml(workspaceId)}/chat/${escapeHtml(turn.id)}/retry" style="display:inline">
                  <button type="submit">Retry</button>
                </form>
              ` : ""}
            </article>
          `;
        }).join("");

        // Activity list
        const activityHtml = activity.events.length === 0
          ? `<p>No activity yet.</p>`
          : `<ul class="activity-list">${activity.events.map((e) => `
            <li><time datetime="${e.createdAt}">${timeAgo(e.createdAt)}</time> ${activityIcon(e.kind)} ${escapeHtml(e.kind)}${e.turnId ? ` <a href="#turn-${e.turnId}">turn</a>` : ""}</li>
          `).join("")}</ul>`;

        // Context chips
        const contextHtml = contextChips.map((c) => contextChip(c, true)).join(" ");

        // Send form
        const sendForm = `
          <form method="post" action="/w/${escapeHtml(workspaceId)}/chat/${escapeHtml(threadId)}/send">
            <div class="context-bar">${contextHtml}</div>
            <textarea name="body" required maxlength="32768" placeholder="Ask about your finances..." rows="3"></textarea>
            <div class="form-actions">
              <input type="hidden" name="idempotencyKey" value="${randomUUID()}">
              <button type="submit">Send</button>
            </div>
          </form>
        `;

        const content = `
          <div class="chat-header">
            <h2>${escapeHtml(view.thread.title || "Untitled conversation")}</h2>
            <p class="meta">Policy v${escapeHtml(eligible.policyVersion)} - Coverage: ${escapeHtml(eligible.coverage)} - ${escapeHtml(String(eligible.accountCount))} accounts</p>
          </div>
          <div class="chat-main">
            <section class="turns" aria-label="Conversation">
              ${turnsHtml}
            </section>
            <aside class="activity-panel" aria-label="Activity">
              <h3>Activity</h3>
              ${activityHtml}
            </aside>
          </div>
          <section class="send-area">
            ${sendForm}
          </section>
        `;
        html(res, 200, page({ title: view.thread.title || "Conversation", requestId, authed: true, content }));
      } catch (err) {
        if (err instanceof TenantDenied) {
          html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such conversation.", back: `/w/${escapeHtml(workspaceId)}/chat`, requestId, authed: true }));
          return true;
        }
        throw err;
      }
      return true;
    }

    // Send message: /w/:workspaceId/chat/:threadId/send
    const sendMatch = path.match(new RegExp(`^/w/${workspaceId}/chat/([A-Za-z0-9-]+)/send$`));
    if (sendMatch && method === "POST") {
      const threadId = sendMatch[1];
      const form = await readFormBody(req).catch(() => null);
      const body = form?.get("body") ?? "";
      const idempotencyKey = form?.get("idempotencyKey") ?? randomUUID();
      try {
        await sendTurn(pool, claims, claims.userId, { threadId, body, idempotencyKey });
        res.writeHead(303, { Location: `/w/${escapeHtml(workspaceId)}/chat/${threadId}` });
        res.end();
      } catch (err) {
        if (err instanceof TenantDenied) {
          html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such conversation.", back: `/w/${escapeHtml(workspaceId)}/chat`, requestId, authed: true }));
          return true;
        }
        throw err;
      }
      return true;
    }

    // Stop generation: /w/:workspaceId/chat/:threadId/stop
    const stopMatch = path.match(new RegExp(`^/w/${workspaceId}/chat/([A-Za-z0-9-]+)/stop$`));
    if (stopMatch && method === "POST") {
      const threadId = stopMatch[1];
      try {
        const view = await getThread(pool, claims, threadId);
        if (view) {
          const runningTurn = view.turns.find((t) => t.role === "assistant" && (t.status === "queued" || t.status === "running"));
          if (runningTurn) {
            await cancelTurn(pool, claims, runningTurn.id);
          }
        }
      } catch { /* ignore */ }
      res.writeHead(303, { Location: `/w/${escapeHtml(workspaceId)}/chat/${threadId}` });
      res.end();
      return true;
    }

    // Retry turn: /w/:workspaceId/chat/:turnId/retry
    const retryMatch = path.match(new RegExp(`^/w/${workspaceId}/chat/([A-Za-z0-9-]+)/retry$`));
    if (retryMatch && method === "POST") {
      const turnId = retryMatch[1];
      try {
        const result = await retryTurn(pool, claims, claims.userId, { turnId, idempotencyKey: randomUUID() });
        res.writeHead(303, { Location: `/w/${escapeHtml(workspaceId)}/chat/${result.assistantTurn.threadId}` });
      } catch (err) {
        if (err instanceof TenantDenied) {
          html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such conversation.", back: `/w/${escapeHtml(workspaceId)}/chat`, requestId, authed: true }));
          return true;
        }
        throw err;
      }
      res.end();
      return true;
    }

    // Activity feed (for reconnect/polling): /w/:workspaceId/chat/:threadId/activity
    const activityMatch = path.match(new RegExp(`^/w/${workspaceId}/chat/([A-Za-z0-9-]+)/activity$`));
    if (activityMatch && method === "GET") {
      const threadId = activityMatch[1];
      const after = parseInt(query.get("after") ?? "0", 10);
      try {
        const activity = await readActivity(pool, claims, threadId, after, 100);
        const eventsHtml = activity.events.map((e) => `
          <li data-seq="${e.seq}"><time datetime="${e.createdAt}">${timeAgo(e.createdAt)}</time> ${activityIcon(e.kind)} ${escapeHtml(e.kind)}${e.turnId ? ` <a href="#turn-${e.turnId}">turn</a>` : ""}</li>
        `).join("");
        html(res, 200, `<ul class="activity-list">${eventsHtml}</ul>`);
      } catch (err) {
        if (err instanceof TenantDenied) {
          html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such conversation.", back: `/w/${escapeHtml(workspaceId)}/chat`, requestId, authed: true }));
          return true;
        }
        throw err;
      }
      return true;
    }

    return false;
  }

  return { handle: shell };
}
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
import { getPolicy, summarizeEligible } from "../ai-policy.ts";
import { readLimitedBody } from "../http-controls.ts";
import { confirmProposal, getProposal, ProposalError } from "../ai-action-proposals.ts";
import { formatMinor, parseDecimalBigint } from "../money.ts";
import { getSettingsView } from "../ai-settings.ts";
import { errorPage, escapeHtml, page, workspaceNav } from "./shell.ts";

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
  if (req.headers["sec-fetch-site"] === "same-origin") return true;
  const allowed = new URL(appBaseUrl).origin;
  const requestOrigins = typeof req.headers.host === "string" ? [`http://${req.headers.host}`, `https://${req.headers.host}`] : [];
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  if (typeof origin === "string") return origin === allowed || requestOrigins.includes(origin);
  if (typeof referer === "string") return [allowed, ...requestOrigins].some((candidate) => referer === candidate || referer.startsWith(`${candidate}/`));
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
  const rem = removable ? `<a href="?" aria-label="Remove ${escapeHtml(label)}">x</a>` : "";
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

    if (method === "POST" && !sameOrigin(req, config.appBaseUrl)) {
      html(res, 403, errorPage({ status: 403, heading: "Request rejected", message: "Submit this form from Moneo.", back: `/w/${escapeHtml(workspaceId)}/chat`, requestId, authed: true }));
      return true;
    }

    if (path === `/w/${workspaceId}/ai-settings` && method === "GET") {
      const settings = await getSettingsView(pool, claims);
      const accounts = await listAccountViews(pool, claims);
      const policy = await getPolicy(pool, claims);
      html(res, 200, page({ title: "Included AI settings", requestId, authed: true, content: `<h2>Included AI settings</h2><dl><dt>Policy version</dt><dd>${escapeHtml(settings.policyVersion)}</dd><dt>Route</dt><dd>${escapeHtml(settings.routeClass)}</dd><dt>Coverage</dt><dd>${escapeHtml(settings.coverage)}</dd><dt>Budget</dt><dd>${escapeHtml(settings.budget.moneyBudgetMinor)} minor units / ${escapeHtml(String(settings.budget.tokenBudget))} tokens</dd><dt>Reserved</dt><dd>${escapeHtml(settings.usage.reservedMoneyMinor)}</dd><dt>Reconciled</dt><dd>${escapeHtml(settings.usage.reconciledMoneyMinor)}</dd><dt>Pending or unknown</dt><dd>${escapeHtml(settings.usage.pendingMoneyMinor)} (${escapeHtml(String(settings.usage.pendingCount))} calls)</dd></dl><h3>Account inclusion</h3><ul>${accounts.map((account) => { const excluded = policy.excludedAccountIds.includes(account.id); return `<li>${escapeHtml(account.name)} — ${excluded ? "excluded" : "included"}<form method="post" action="/w/${escapeHtml(workspaceId)}/exclusions"><input type="hidden" name="accountId" value="${escapeHtml(account.id)}"><input type="hidden" name="excluded" value="${excluded ? "false" : "true"}"><input type="hidden" name="policyVersion" value="${escapeHtml(policy.policyVersion)}"><input type="hidden" name="returnTo" value="ai-settings"><button type="submit">${excluded ? "Include" : "Exclude"}</button></form></li>`; }).join("") || "<li>No accounts</li>"}</ul><h3>System prompt</h3><p>Version prompt-1. Product-managed and read-only; tenant data and credentials are not displayed.</p>` }));
      return true;
    }

    const proposalMatch = path.match(new RegExp(`^/w/${workspaceId}/ai-actions/([A-Za-z0-9-]+)$`));
    if (proposalMatch && method === "GET") {
      const proposal = await getProposal(pool, claims, proposalMatch[1]);
      if (!proposal) {
        html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such proposal.", back: `/w/${workspaceId}/chat`, requestId, authed: true }));
        return true;
      }
      const p = proposal.payload;
      const amount = formatMinor(parseDecimalBigint(p.amountMinor), p.currency);
      html(res, 200, page({ title: "Confirm transaction", requestId, authed: true, content: `<dialog open aria-labelledby="proposal-title"><h2 id="proposal-title">Confirm transaction</h2><dl><dt>Account</dt><dd>${escapeHtml(p.accountId)}</dd><dt>Amount</dt><dd>${escapeHtml(amount)} ${escapeHtml(p.currency)}</dd><dt>Direction</dt><dd>${escapeHtml(p.direction)}</dd><dt>Date</dt><dd>${escapeHtml(p.effectiveDate)}</dd><dt>Description</dt><dd>${escapeHtml(p.description)}</dd></dl><form method="post" action="/w/${escapeHtml(workspaceId)}/ai-actions/${escapeHtml(proposal.id)}/confirm"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><button type="submit">Confirm transaction</button> <a href="/w/${escapeHtml(workspaceId)}/chat">Cancel</a></form></dialog>` }));
      return true;
    }

    const confirmMatch = path.match(new RegExp(`^/w/${workspaceId}/ai-actions/([A-Za-z0-9-]+)/confirm$`));
    if (confirmMatch && method === "POST") {
      const form = await readFormBody(req).catch(() => null);
      try {
        const result = await confirmProposal(pool, claims, claims.userId, confirmMatch[1], form?.get("idempotencyKey") ?? "");
        res.writeHead(303, { Location: `/w/${workspaceId}/transactions?notice=ai-confirmed&operationId=${result.operationId}` });
        res.end();
      } catch (err) {
        const status = err instanceof ProposalError ? (err.code === "expired" ? 410 : err.code === "not_found" ? 404 : 409) : 400;
        html(res, status, errorPage({ status, heading: "Confirmation failed", message: err instanceof ProposalError ? err.code : "invalid_request", back: `/w/${workspaceId}/chat`, requestId, authed: true }));
      }
      return true;
    }

    // Chat thread list: /w/:workspaceId/chat
    if (path === `/w/${workspaceId}/chat` && method === "GET") {
      const threads = await listThreads(pool, claims);
      const content = threads.length === 0
        ? `<p>No conversations yet.</p><p><a href="/w/${escapeHtml(workspaceId)}/chat/new">Start a new conversation</a></p>`
        : `<ul>${threads.map((t) => `<li><a href="/w/${escapeHtml(workspaceId)}/chat/${escapeHtml(t.id)}">${escapeHtml(t.title || "Untitled")}</a> - ${timeAgo(t.createdAt)}</li>`).join("")}</ul>`;
      html(res, 200, page({ title: "Conversations", requestId, authed: true, content: `${workspaceNav(workspaceId)}<p><a href="/w/${escapeHtml(workspaceId)}/chat/new">New conversation</a></p>${content}` }));
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
        const [summary, eligible, policy] = await Promise.all([
          getFinancialSummary(pool, claims, workspaceId),
          summarizeEligible(pool, claims),
          getPolicy(pool, claims),
        ]);
        const requestedAccountId = query.get("accountId");
        const contextAccount = requestedAccountId && !policy.excludedAccountIds.includes(requestedAccountId) ? accounts.find((account) => account.id === requestedAccountId) : undefined;
        const contextChips = [
          ...(contextAccount ? [`Account: ${contextAccount.name}`] : []),
          `Coverage: ${eligible.coverage}`,
          `Policy: v${eligible.policyVersion}`,
          `${eligible.accountCount} eligible accounts`,
        ];

        // Render turns
        const turnsHtml = view.turns.map((turn) => {
          const isUser = turn.role === "user";
          const badge = isUser ? "" : statusBadge(turn.status);
          const bodyHtml = isUser ? escapeHtml(turn.body) : renderMarkdown(turn.body);
          const evidence = view.attempts.filter((attempt) => attempt.turnId === turn.id).flatMap((attempt) => attempt.evidenceIds);
          return `
            <article id="turn-${escapeHtml(turn.id)}" class="turn ${turn.role}">
              <header>
                <strong>${isUser ? "You" : "Assistant"}</strong>
                ${badge}
                <time datetime="${turn.createdAt}">${timeAgo(turn.createdAt)}</time>
              </header>
              <div class="turn-body">${bodyHtml}</div>
              ${evidence.length ? `<p class="evidence"><strong>Evidence:</strong> ${evidence.map((ref) => `<a id="evidence-${escapeHtml(ref)}" href="#evidence-${escapeHtml(ref)}">${escapeHtml(ref)}</a>`).join(", ")}</p>` : ""}
              ${!isUser && (turn.status === "queued" || turn.status === "running") ? `
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
        const contextHtml = contextChips.map((c, index) => contextChip(c, index === 0 && contextAccount !== undefined)).join(" ");

        // Send form
        const sendForm = `
          <form method="post" action="/w/${escapeHtml(workspaceId)}/chat/${escapeHtml(threadId)}/send">
            <div class="context-bar">${contextHtml}</div>
            ${contextAccount ? `<input type="hidden" name="accountId" value="${escapeHtml(contextAccount.id)}">` : ""}
            <textarea name="body" required maxlength="32768" placeholder="Ask about your finances..." rows="3"></textarea>
            <div class="form-actions">
              <input type="hidden" name="idempotencyKey" value="${randomUUID()}">
              <button type="submit">Send</button>
            </div>
          </form>
        `;

        const content = `
          ${workspaceNav(workspaceId)}
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
      const accountId = form?.get("accountId");
      const idempotencyKey = form?.get("idempotencyKey") ?? randomUUID();
      try {
        let authorizedBody = body;
        if (accountId) {
          const [accounts, policy] = await Promise.all([listAccountViews(pool, claims), getPolicy(pool, claims)]);
          const account = accounts.find((candidate) => candidate.id === accountId);
          if (!account || policy.excludedAccountIds.includes(accountId)) throw new TenantDenied();
          authorizedBody = `[Context account: ${account.name} (${account.id})]\n${body}`;
        }
        await sendTurn(pool, claims, claims.userId, { threadId, body: authorizedBody, idempotencyKey });
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
      } catch (err) {
        if (!(err instanceof TenantDenied)) throw err;
      }
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

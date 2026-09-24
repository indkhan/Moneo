// E03-S07 server-rendered recurring page (zero client JS). Lists
// deterministic candidates with warnings, confirms with an explicit kind +
// day, dismisses sparse or unwanted series. Same-origin gates, per-render
// idempotency keys, conflict shells with fresh retry — same conventions as
// the transaction table.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { formatMinor } from "../money.ts";
import { TxError } from "../commands/transactions.ts";
import { confirm as confirmCmd, dismiss as dismissCmd } from "../commands/recurring.ts";
import { TenantDenied, TenantInvalid, sessionClaims, type SessionResolver } from "../tenancy.ts";
import { listRecurring } from "../commands/recurring.ts";
import { readLimitedBody } from "../http-controls.ts";
import { errorPage, escapeHtml, page } from "./shell.ts";

export type RecurringUiConfig = { appBaseUrl: string };

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

export async function handleRecurringRoutes(
  pool: Pool,
  resolveSession: SessionResolver,
  config: RecurringUiConfig,
  event: (code: string) => void,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  query: URLSearchParams,
  requestId = "uncontrolled",
): Promise<boolean> {
  const pageMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/recurring$/);
  if (pageMatch && method === "GET") {
    const workspaceId = pageMatch[1];
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.session) {
      html(res, 401, errorPage({ status: 401, heading: "Sign in required", message: "Log in to view recurring items.", back: "/", requestId, authed: false }));
      return true;
    }
    if (!resolved.claim) {
      event("ui_denied:recurring");
      html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
      return true;
    }
    try {
      const { candidates, scanned, truncated } = await listRecurring(pool, resolved.claim);
      const notice =
        query.get("notice") === "confirmed"
          ? `<div class="notice" role="status"><p>Schedule confirmed as an assumption — it is not a booked transaction.</p></div>`
          : query.get("notice") === "dismissed"
            ? `<div class="notice" role="status"><p>Series dismissed.</p></div>`
            : "";
      const rows =
        candidates.length === 0
          ? `<p>No recurring candidates in the last ${escapeHtml(String(scanned))} booked rows.</p>`
          : `<div style="overflow-x:auto"><table><caption>Recurring candidates</caption><thead><tr><th scope="col">Description</th><th scope="col">Amount</th><th scope="col">Occurrences</th><th scope="col">Status</th><th scope="col">Warnings</th><th scope="col">Schedule assumption</th><th scope="col">Actions</th></tr></thead><tbody>${candidates
              .map((c) => {
                const amount = (() => {
                  try {
                    return `${formatMinor(BigInt(c.amountMinor), c.currency)} ${c.currency}`;
                  } catch {
                    return `${c.amountMinor} ${c.currency}`;
                  }
                })();
                const status = c.override ? c.override.status : c.status === "candidate" ? "proposed" : "sparse";
                const assumption = c.override?.status === "confirmed" ? `${c.override.kind} day ${c.override.dayOfMonth} (assumption — not booked)` : "none";
                const actions =
                  c.override?.status === "confirmed" || c.override?.status === "dismissed"
                    ? `<span>Decided (${escapeHtml(c.override.status)})</span>`
                    : `<form method="post" action="/w/${escapeHtml(workspaceId)}/recurring/dismiss"><input type="hidden" name="fingerprint" value="${escapeHtml(c.fingerprint)}"><input type="hidden" name="expectedVersion" value="${escapeHtml(c.confirmVersion)}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><button type="submit">Dismiss</button></form>` +
                      (c.confirmable
                        ? ` <form method="post" action="/w/${escapeHtml(workspaceId)}/recurring/confirm"><input type="hidden" name="fingerprint" value="${escapeHtml(c.fingerprint)}"><input type="hidden" name="expectedVersion" value="${escapeHtml(c.confirmVersion)}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><label>Kind <select name="kind"><option value="expense">Expense</option><option value="income">Income</option></select></label> <label>Day <input name="dayOfMonth" inputmode="numeric" pattern="[0-9]*" maxlength="2" required value="1"></label> <button type="submit">Confirm</button></form>`
                        : ` <span>Too little history to confirm.</span>`);
                return `<tr><td>${escapeHtml(c.description)}</td><td>${escapeHtml(amount)}</td><td>${escapeHtml(String(c.occurrences))} (${escapeHtml(c.firstDate)} to ${escapeHtml(c.lastDate)})</td><td>${escapeHtml(status)}</td><td>${c.warnings.map((w) => escapeHtml(w)).join(" ")}</td><td>${escapeHtml(assumption)}</td><td>${actions}</td></tr>`;
              })
              .join("")}</tbody></table></div>`;
      html(
        res,
        200,
        page({
          title: "Recurring",
          requestId,
          authed: true,
          content: `<h2>Recurring</h2>${notice}<p>Derived from booked rows (scanned ${escapeHtml(String(scanned))}${truncated ? ", truncated at the scan cap" : ""}). Confirmations are assumptions, never booked transactions.</p>${rows}<p><a href="/w/${escapeHtml(workspaceId)}/transactions">Back to transactions</a></p>`,
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof TenantInvalid || err instanceof TenantDenied) {
        html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
        return true;
      }
      throw err;
    }
  }

  const actionMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/recurring\/(confirm|dismiss)$/);
  if (actionMatch && method === "POST") {
    const workspaceId = actionMatch[1];
    const action = actionMatch[2];
    if (!sameOrigin(req, config.appBaseUrl)) {
      event("ui_denied:origin");
      html(res, 403, errorPage({ status: 403, heading: "Forbidden", message: "Cross-origin form posts are rejected.", back: `/w/${workspaceId}/recurring`, requestId, authed: true }));
      return true;
    }
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.claim) {
      const authed = resolved.session !== null;
      html(res, authed ? 404 : 401, errorPage({ status: authed ? 404 : 401, heading: authed ? "Not found" : "Sign in required", message: "No such workspace.", back: "/", requestId, authed }));
      return true;
    }
    const form = await readFormBody(req).catch(() => null);
    const fingerprint = form?.get("fingerprint") ?? "";
    const expectedVersion = form?.get("expectedVersion") ?? "";
    const idempotencyKey = form?.get("idempotencyKey") ?? "";
    try {
      if (action === "confirm") {
        const kind = form?.get("kind") ?? "";
        const dayOfMonth = Number(form?.get("dayOfMonth") ?? "");
        await confirmCmd(pool, resolved.claim, resolved.claim.userId, { workspaceId, fingerprint, kind, dayOfMonth, expectedVersion, idempotencyKey });
      } else {
        await dismissCmd(pool, resolved.claim, resolved.claim.userId, { workspaceId, fingerprint, expectedVersion, idempotencyKey });
      }
      event(`ui_command_ok:recurring-${action}`);
      res.writeHead(303, { Location: `/w/${workspaceId}/recurring?notice=${action === "confirm" ? "confirmed" : "dismissed"}` });
      res.end();
      return true;
    } catch (err) {
      if (err instanceof TxError && (err.code === "version_mismatch" || err.code === "idempotency_reuse" || err.code === "idempotency_expired")) {
        event(`ui_command_conflict:recurring-${action}`);
        html(
          res,
          409,
          page({
            title: "Schedule conflict",
            requestId,
            authed: true,
            content: `<div class="alert" role="alert"><h2>Schedule conflict</h2><p>This series changed before your update (now version ${escapeHtml(err.currentVersion ?? "unknown")}). Nothing was changed. Reopen the page for fresh values and retry.</p><p><a href="/w/${escapeHtml(workspaceId)}/recurring">Back to recurring</a></p></div>`,
          }),
        );
        return true;
      }
      if (err instanceof TxError || err instanceof TenantInvalid || err instanceof TenantDenied) {
        event(`ui_command_denied:recurring-${action}`);
        const status = err instanceof TxError && err.code === "not_found" ? 404 : 400;
        html(res, status, errorPage({ status, heading: status === 404 ? "Not found" : "Update failed", message: status === 404 ? "No such series." : "Check the values (kind expense/income, day 1–28) and retry.", back: `/w/${workspaceId}/recurring`, requestId, authed: true }));
        return true;
      }
      throw err;
    }
  }

  return false;
}

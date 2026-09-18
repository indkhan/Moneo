// E01-S06 UI routes: server-rendered HTML over the same domain functions
// the API uses (no parallel data path). Forms POST with per-render
// idempotency keys; conflicts re-render with the current version and a
// prefilled retry form. Same-origin POST protection mirrors /auth/logout.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { isUuid } from "../ids.ts";
import { CommandError, renameAccount, validateRenameInput } from "../commands/accounts.ts";
import { getPolicy, PolicyError, setAccountExclusion, summarizeEligible } from "../ai-policy.ts";
import { getAccountView, listAccountViews } from "../commands/accounts.ts";
import { clearSessionCookie, revokeRequestSession } from "../auth.ts";
import { readLimitedBody } from "../http-controls.ts";
import { listWorkspaces, sessionClaims, TenantDenied, TenantInvalid, type SessionResolver } from "../tenancy.ts";
import { errorPage, escapeHtml, page } from "./shell.ts";

export type UiConfig = {
  appBaseUrl: string;
  sessionSecret: string;
  onEvent?: (code: string) => void;
};

function html(res: ServerResponse, status: number, body: string): void {
  const payload = body;
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  });
  res.end(payload);
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

export function createUiRouter(pool: Pool, resolveSession: SessionResolver, config: UiConfig): {
  handle: (req: IncomingMessage, res: ServerResponse, path: string, method: string, query: URLSearchParams, requestId?: string) => Promise<boolean>;
} {
  const event = config.onEvent ?? (() => {});

  async function shell(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    method: string,
    query: URLSearchParams,
    requestId = "uncontrolled",
  ): Promise<boolean> {
    // Every UI POST reads its form body (sole "data" listener); GETs discard.
    if (method !== "POST") req.resume();
    req.on("error", () => {});
    const authedOf = async (): Promise<{ sub: string } | null> => {
      const session = await resolveSession(req);
      return session ? { sub: session.keycloakSub } : null;
    };

    if ((path === "/" || path === "/index.html") && method === "GET") {
      const me = await authedOf();
      if (!me) {
        const notice = query.get("notice") === "logged-out" ? "Signed out." : undefined;
        html(res, 200, page({ title: "Moneo", requestId, authed: false, notice, content: `<p>Sign in to see your workspaces.</p><p><a href="/auth/login">Log in</a></p>` }));
        return true;
      }
      const spaces = await listWorkspaces(pool, me.sub);
      const items =
        spaces.length === 0
          ? `<p>No workspaces yet. Create one with the API; the shell lists it here.</p>`
          : `<ul>${spaces.map((w) => `<li><a href="/w/${escapeHtml(w.id)}">${escapeHtml(w.name)}</a> — ${escapeHtml(w.baseCurrency)}</li>`).join("")}</ul>`;
      const notice = query.get("notice") === "logged-out" ? "Signed out." : undefined;
      html(res, 200, page({ title: "Workspaces", requestId, authed: true, notice, content: items }));
      return true;
    }

    const workspaceMatch = path.match(/^\/w\/([A-Za-z0-9-]+)$/);
    if (workspaceMatch && method === "GET") {
      const workspaceId = workspaceMatch[1];
      const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
      if (!resolved.session) {
        html(res, 401, errorPage({ status: 401, heading: "Sign in required", message: "Log in to view this workspace.", back: "/", requestId, authed: false }));
        return true;
      }
      if (!resolved.claim) {
        event("ui_denied:workspace");
        html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
        return true;
      }
      let accounts, policy, summary;
      try {
        [accounts, policy, summary] = await Promise.all([
          listAccountViews(pool, resolved.claim),
          getPolicy(pool, resolved.claim),
          summarizeEligible(pool, resolved.claim),
        ]);
      } catch (err) {
        if (err instanceof TenantDenied) {
          event("ui_denied:workspace");
          html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
          return true;
        }
        throw err;
      }
      const excluded = new Set(policy.excludedAccountIds);
      const rows =
        accounts.length === 0
          ? `<p>No accounts yet.</p>`
          : `<table><caption>Accounts</caption><thead><tr><th scope="col">Name</th><th scope="col">Version</th><th scope="col">AI</th><th scope="col">Rename</th><th scope="col">AI access</th></tr></thead><tbody>${accounts
              .map(
                (a) => `<tr><td>${escapeHtml(a.name)}</td><td>${escapeHtml(a.version)}</td><td>${
                  excluded.has(a.id) ? "excluded" : "included"
                }</td><td><form method="post" action="/w/${escapeHtml(workspaceId)}/rename"><input type="hidden" name="accountId" value="${escapeHtml(a.id)}"><input type="hidden" name="expectedVersion" value="${escapeHtml(a.version)}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><label>New name <input name="name" required maxlength="200" value="${escapeHtml(a.name)}"></label> <button type="submit">Rename</button></form></td><td><form method="post" action="/w/${escapeHtml(workspaceId)}/exclusions"><input type="hidden" name="accountId" value="${escapeHtml(a.id)}"><input type="hidden" name="excluded" value="${excluded.has(a.id) ? "false" : "true"}"><button type="submit">${excluded.has(a.id) ? "Include in AI" : "Exclude from AI"}</button></form></td></tr>`,
              )
              .join("")}</tbody></table>`;
      // Raw query values: page() escapes at the boundary (pre-escaping here
      // would double-escape).
      const notice =
        query.get("notice") === "renamed"
          ? "Account renamed."
          : query.get("notice") === "exclusion-updated"
            ? `AI policy updated (version ${query.get("policyVersion") ?? ""}).`
            : undefined;
      html(
        res,
        200,
        page({
          title: "Workspace",
          requestId,
          authed: true,
          notice,
          content: `<p>AI coverage: ${escapeHtml(summary.coverage)} (${escapeHtml(String(summary.accountCount))} of ${escapeHtml(String(accounts.length))} accounts eligible, policy v${escapeHtml(summary.policyVersion)}).</p>${rows}`,
        }),
      );
      return true;
    }

    // Browser logout bridge: the JSON /auth/logout endpoint cannot navigate,
    // so the shell posts here for revoke-then-land behavior (zero-JS flow).
    if (path === "/logout" && method === "POST") {
      if (!sameOrigin(req, config.appBaseUrl)) {
        event("ui_denied:origin");
        html(res, 403, errorPage({ status: 403, heading: "Forbidden", message: "Cross-origin form posts are rejected.", back: "/", requestId, authed: true }));
        return true;
      }
      await revokeRequestSession(pool, config.sessionSecret, req);
      clearSessionCookie(res, config.appBaseUrl.startsWith("https://"));
      res.writeHead(303, { Location: "/?notice=logged-out" });
      res.end();
      return true;
    }

    const actionMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/(rename|exclusions)$/);
    if (actionMatch && method === "POST" && actionMatch[2] === "rename") {
      const workspaceId = actionMatch[1];
      if (!sameOrigin(req, config.appBaseUrl)) {
        event("ui_denied:origin");
        html(res, 403, errorPage({ status: 403, heading: "Forbidden", message: "Cross-origin form posts are rejected.", back: `/w/${workspaceId}`, requestId, authed: true }));
        return true;
      }
      const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
      if (!resolved.claim) {
        const authed = resolved.session !== null;
        html(res, authed ? 404 : 401, errorPage({ status: authed ? 404 : 401, heading: authed ? "Not found" : "Sign in required", message: "No such workspace.", back: "/", requestId, authed }));
        return true;
      }
      const form = await readFormBody(req).catch(() => null);
      const raw = {
        workspaceId,
        accountId: form?.get("accountId") ?? "",
        name: form?.get("name") ?? "",
        expectedVersion: form?.get("expectedVersion") ?? "",
        idempotencyKey: form?.get("idempotencyKey") ?? "",
      };
      const conflictShell = async (heading: string, message: string, status: number): Promise<void> => {
        // Fresh-key retry form: a conflicted key must never be resubmitted.
        const current = typeof raw.accountId === "string" && isUuid(raw.accountId) ? await getAccountView(pool, resolved.claim!, raw.accountId).catch(() => null) : null;
        event("ui_command_conflict:rename");
        html(
          res,
          status,
          page({
            title: heading,
            requestId,
            authed: true,
            content: `<div class="alert" role="alert"><h2>${escapeHtml(heading)}</h2><p>${escapeHtml(message)}</p><p><a href="/w/${escapeHtml(workspaceId)}">Back to workspace</a></p></div>
              ${
              current
                ? `<form method="post" action="/w/${escapeHtml(workspaceId)}/rename"><input type="hidden" name="accountId" value="${escapeHtml(current.id)}"><input type="hidden" name="expectedVersion" value="${escapeHtml(current.version)}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><label>New name <input name="name" required maxlength="200" value="${escapeHtml(typeof raw.name === "string" ? raw.name : current.name)}"></label> <button type="submit">Retry rename</button></form>`
                : ``
            }`,
          }),
        );
      };
      try {
        const input = validateRenameInput(raw);
        await renameAccount(pool, resolved.claim, resolved.claim.userId, input);
        event("ui_command_ok:rename");
        res.writeHead(303, { Location: `/w/${workspaceId}?notice=renamed` });
        res.end();
        return true;
      } catch (err) {
        if (err instanceof CommandError && (err.code === "version_mismatch" || err.code === "idempotency_reuse" || err.code === "idempotency_expired")) {
          const message =
            err.code === "version_mismatch"
              ? `Someone else changed this account. Current version is ${err.currentVersion ?? "unknown"}. Review and retry.`
              : `This form was already submitted (${err.code === "idempotency_reuse" ? "changed values" : "expired key"}). Review the current values and retry with a fresh form.`;
          await conflictShell("Rename conflict", message, 409);
          return true;
        }
        if (err instanceof CommandError || err instanceof TenantInvalid || err instanceof TenantDenied) {
          event("ui_command_denied:rename");
          const status = err instanceof CommandError && err.code === "not_found" ? 404 : err instanceof TenantDenied ? 404 : 400;
          html(res, status, errorPage({ status, heading: status === 404 ? "Not found" : "Rename failed", message: status === 404 ? "No such workspace or account." : "Check the values and retry.", back: `/w/${workspaceId}`, requestId, authed: true }));
          return true;
        }
        throw err;
      }
    }

    if (actionMatch && method === "POST" && actionMatch[2] === "exclusions") {
      const workspaceId = actionMatch[1];
      if (!sameOrigin(req, config.appBaseUrl)) {
        event("ui_denied:origin");
        html(res, 403, errorPage({ status: 403, heading: "Forbidden", message: "Cross-origin form posts are rejected.", back: `/w/${workspaceId}`, requestId, authed: true }));
        return true;
      }
      const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
      if (!resolved.claim) {
        const authed = resolved.session !== null;
        html(res, authed ? 404 : 401, errorPage({ status: authed ? 404 : 401, heading: authed ? "Not found" : "Sign in required", message: "No such workspace.", back: "/", requestId, authed }));
        return true;
      }
      const form = await readFormBody(req).catch(() => null);
      const accountId = form?.get("accountId") ?? "";
      const excluded = form?.get("excluded") === "true";
      if (!isUuid(accountId)) {
        html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such account.", back: `/w/${workspaceId}`, requestId, authed: true }));
        return true;
      }
      try {
        const state = await setAccountExclusion(pool, resolved.claim, resolved.claim.userId, accountId, excluded);
        res.writeHead(303, { Location: `/w/${workspaceId}?notice=exclusion-updated&policyVersion=${encodeURIComponent(state.policyVersion)}` });
        res.end();
        return true;
      } catch (err) {
        if (err instanceof PolicyError || err instanceof TenantDenied) {
          event("ui_denied:exclusion");
          html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace or account.", back: `/w/${workspaceId}`, requestId, authed: true }));
          return true;
        }
        throw err;
      }
    }

    return false;
  }

  return { handle: shell };
}

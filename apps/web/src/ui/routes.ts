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
import { readMultipart } from "../multipart.ts";
import { acceptUpload, listObservations, loadUploadConfig, MAX_UPLOAD_BYTES, readImport, UploadError } from "../uploads.ts";
import { acceptMapping, listMappingProfiles, loadMappingSample, MappingError, proposeMapping, readCurrentMapping } from "../mapping.ts";
import { liveMappingTransport, loadMappingProvider } from "../mapping-provider.ts";
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
          content: `<p>AI coverage: ${escapeHtml(summary.coverage)} (${escapeHtml(String(summary.accountCount))} of ${escapeHtml(String(accounts.length))} accounts eligible, policy v${escapeHtml(summary.policyVersion)}).</p><p><a href="/w/${escapeHtml(workspaceId)}/imports/new">Import a bank file (CSV/XLSX)</a></p>${rows}`,
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

    // E02-S03 minimal import upload: native file form (keyboard by
    // construction), allowlist + size help, typed error shells. S06 owns
    // multi-file polish, progress streaming and review queues.
    const importsNewMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/imports\/new$/);
    if (importsNewMatch && method === "GET") {
      const workspaceId = importsNewMatch[1];
      const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
      if (!resolved.session) {
        html(res, 401, errorPage({ status: 401, heading: "Sign in required", message: "Log in to import files.", back: "/", requestId, authed: false }));
        return true;
      }
      if (!resolved.claim) {
        event("ui_denied:workspace");
        html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
        return true;
      }
      let uploadsReady = true;
      try {
        loadUploadConfig();
      } catch {
        uploadsReady = false;
      }
      const help = `<p>Accepted formats: <strong>.csv</strong> and <strong>.xlsx</strong> only, up to 20 MiB. Files are scanned for malware and parsed in a bounded worker; rejected files explain why.</p>`;
      const content = uploadsReady
        ? `${help}<form method="post" action="/w/${escapeHtml(workspaceId)}/imports" enctype="multipart/form-data"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><p><label for="upload-file">Bank file</label> <input id="upload-file" type="file" name="file" accept=".csv,.xlsx" required></p><p><button type="submit">Upload and parse</button></p></form>`
        : `${help}<div class="alert" role="alert"><h2>Imports unavailable</h2><p>File intake is temporarily disabled. Try again later.</p></div>`;
      html(res, 200, page({ title: "Import a bank file", requestId, authed: true, content }));
      return true;
    }

    const importsPostMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/imports$/);
    if (importsPostMatch && method === "POST") {
      const workspaceId = importsPostMatch[1];
      if (!sameOrigin(req, config.appBaseUrl)) {
        event("ui_denied:origin");
        html(res, 403, errorPage({ status: 403, heading: "Forbidden", message: "Cross-origin form posts are rejected.", back: `/w/${workspaceId}`, requestId, authed: true }));
        return true;
      }
      const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
      if (!resolved.claim) {
        const authed = resolved.session !== null;
        req.resume();
        html(res, authed ? 404 : 401, errorPage({ status: authed ? 404 : 401, heading: authed ? "Not found" : "Sign in required", message: "No such workspace.", back: "/", requestId, authed }));
        return true;
      }
      let uploadConfig;
      try {
        uploadConfig = loadUploadConfig();
      } catch {
        event("ui_uploads_disabled");
        html(res, 404, errorPage({ status: 404, heading: "Not found", message: "File intake is temporarily disabled.", back: `/w/${workspaceId}`, requestId, authed: true }));
        return true;
      }
      const fail = (status: number, heading: string, message: string): void => {
        event("ui_upload_denied");
        html(res, status, errorPage({ status, heading, message, back: `/w/${workspaceId}/imports/new`, requestId, authed: true }));
      };
      let form;
      try {
        form = await readMultipart(req, { maxBytes: MAX_UPLOAD_BYTES + 64 * 1024 });
      } catch (err) {
        if (err instanceof Error && err.message === "body_too_large") fail(413, "File too large", "Files above 20 MiB are not accepted. Split the statement and retry.");
        else fail(400, "Upload failed", "The submission could not be read. Retry with a CSV or XLSX file.");
        return true;
      }
      try {
        if (!form.file) throw new UploadError("invalid_request", "missing-file");
        if (typeof form.fields["idempotencyKey"] !== "string" || !isUuid(form.fields["idempotencyKey"])) {
          throw new UploadError("invalid_request", "bad-idempotency-key");
        }
        const result = await acceptUpload(pool, resolved.claim, resolved.claim.userId, uploadConfig, {
          workspaceId,
          idempotencyKey: form.fields["idempotencyKey"],
          filename: form.file.filename,
          bytes: form.file.bytes,
        });
        event("ui_upload_ok");
        res.writeHead(303, { Location: `/w/${workspaceId}/imports/${result.import.id}` });
        res.end();
        return true;
      } catch (err) {
        if (err instanceof UploadError && err.code === "idempotency_reuse") {
          fail(409, "Already submitted", "This form was already submitted with different content. Check the import status or start a fresh upload.");
          return true;
        }
        if (err instanceof UploadError && err.code === "payload_too_large") {
          fail(413, "File too large", "Files above 20 MiB are not accepted. Split the statement and retry.");
          return true;
        }
        if (err instanceof UploadError || err instanceof TenantInvalid || err instanceof TenantDenied) {
          fail(err instanceof TenantDenied ? 404 : 400, err instanceof TenantDenied ? "Not found" : "Upload failed", "Only validated CSV or XLSX files are accepted. Check the format and retry.");
          return true;
        }
        throw err;
      }
    }

    const importStatusMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/imports\/([A-Za-z0-9-]+)$/);
    if (importStatusMatch && method === "GET") {
      const workspaceId = importStatusMatch[1];
      const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
      if (!resolved.session) {
        html(res, 401, errorPage({ status: 401, heading: "Sign in required", message: "Log in to view imports.", back: "/", requestId, authed: false }));
        return true;
      }
      if (!resolved.claim) {
        event("ui_denied:workspace");
        html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
        return true;
      }
      let viewed;
      try {
        viewed = await readImport(pool, resolved.claim, importStatusMatch[2]);
      } catch (err) {
        if (err instanceof TenantDenied) {
          html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such import.", back: `/w/${workspaceId}`, requestId, authed: true }));
          return true;
        }
        throw err;
      }
      if (!viewed) {
        html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such import.", back: `/w/${workspaceId}`, requestId, authed: true }));
        return true;
      }
      const sample = await listObservations(pool, resolved.claim, importStatusMatch[2], { limit: 5 }).catch(() => ({ rows: [], total: 0 }));
      const stateLine =
        viewed.status === "STAGED"
          ? `Parsed ${escapeHtml(viewed.rowCount ?? "?")} rows: ${escapeHtml(viewed.stagedCount ?? "?")} staged, ${escapeHtml(viewed.reviewCount ?? "?")} need review, ${escapeHtml(viewed.rejectedCount ?? "?")} rejected.`
          : viewed.status === "REJECTED"
            ? `Rejected (${escapeHtml(viewed.errorCode ?? "unknown reason")}). No rows entered review or totals.`
            : `Status ${escapeHtml(viewed.status)} — refresh this page to update; processing continues in the background.`;
      const sampleRows =
        sample.rows.length === 0
          ? `<p>No staged rows to preview yet.</p>`
          : `<table><caption>First staged rows</caption><thead><tr><th scope="col">Row</th><th scope="col">Date</th><th scope="col">Description</th><th scope="col">Status</th></tr></thead><tbody>${sample.rows
              .map((row) => `<tr><td>${escapeHtml(String(row.rowNo))}</td><td>${escapeHtml(row.effectiveDate ?? "—")}</td><td>${escapeHtml(row.description ?? "—")}</td><td>${escapeHtml(row.status)}</td></tr>`)
              .join("")}</tbody></table>`;
      html(
        res,
        200,
        page({
          title: "Import status",
          requestId,
          authed: true,
          content: `<h2>${escapeHtml(viewed.fileName)}</h2><p>${stateLine}</p>${sampleRows}<p><a href="/w/${escapeHtml(workspaceId)}/imports/${escapeHtml(importStatusMatch[2])}/mapping">Map columns for this import</a> · <a href="/w/${escapeHtml(workspaceId)}">Back to workspace</a></p>`,
        }),
      );
      return true;
    }

    // E02-S04 manual mapper: semantic selects over the staged header, sample
    // preview, validation summary with focus to the first blocking field,
    // keyboard-native submit. AI assistance runs only via the propose step
    // when configured; the form itself never calls a model.
    const mapperMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/imports\/([A-Za-z0-9-]+)\/mapping$/);
    if (mapperMatch && (method === "GET" || method === "POST")) {
      const workspaceId = mapperMatch[1];
      const importId = mapperMatch[2];
      if (method === "POST" && !sameOrigin(req, config.appBaseUrl)) {
        event("ui_denied:origin");
        html(res, 403, errorPage({ status: 403, heading: "Forbidden", message: "Cross-origin form posts are rejected.", back: `/w/${workspaceId}`, requestId, authed: true }));
        return true;
      }
      const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
      if (!resolved.session) {
        if (method === "POST") req.resume();
        html(res, 401, errorPage({ status: 401, heading: "Sign in required", message: "Log in to map imports.", back: "/", requestId, authed: false }));
        return true;
      }
      if (!resolved.claim) {
        if (method === "POST") req.resume();
        event("ui_denied:workspace");
        html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace or import.", back: "/", requestId, authed: true }));
        return true;
      }
      const failMapper = (status: number, heading: string, message: string): void => {
        event("ui_mapping_denied");
        html(res, status, errorPage({ status, heading, message, back: `/w/${workspaceId}`, requestId, authed: true }));
      };
      if (method === "POST") {
        // urlencoded mapper forms (the file intake POST is multipart and
        // lives on its own route; this form never carries bytes).
        const form = await readFormBody(req).catch(() => null);
        if (!form) {
          failMapper(400, "Mapping failed", "The submission could not be read. Retry the form.");
          return true;
        }
        const action = form.get("action") ?? "";
        try {
          if (action === "propose") {
            const mode = form.get("mode") === "manual" ? "manual" : "auto";
            const provider = mode === "manual" ? null : loadMappingProvider();
            await proposeMapping(pool, resolved.claim, importId, {
              transport: provider ? liveMappingTransport(provider) : null,
              replace: form.get("replace") === "1",
            });
            event("ui_mapping_ok:propose");
            res.writeHead(303, { Location: `/w/${workspaceId}/imports/${importId}/mapping` });
            res.end();
            return true;
          }
          if (action === "accept") {
            const pick = (name: string): string | undefined => {
              const value = form.get(name) ?? "";
              return value === "" ? undefined : value;
            };
            const columns: Record<string, string> = {};
            for (const role of ["date", "description", "amount", "debit", "credit", "currency"]) {
              const value = pick(`col_${role}`);
              if (value !== undefined) columns[role] = value;
            }
            const delimiter = pick("delimiter") ?? "";
            if (delimiter !== "," && delimiter !== ";") {
              failMapper(400, "Mapping failed", "The form submission could not be read. Retry the form.");
              return true;
            }
            const profile = {
              delimiter,
              dateFormat: pick("dateFormat") ?? "iso",
              amount: { kind: pick("kind") === "debit-credit" ? "debit-credit" : "signed", decimalSep: pick("decimalSep") ?? ".", thousandsSep: pick("thousandsSep") ?? "" },
              columns,
              ...(pick("defaultCurrency") ? { defaultCurrency: pick("defaultCurrency") } : {}),
            };
            await acceptMapping(pool, resolved.claim, importId, {
              proposalId: form.get("proposalId") ?? "",
              ...(pick("accountId") ? { accountId: pick("accountId") } : {}),
              profile,
              ...(pick("saveAs") ? { saveAs: pick("saveAs") } : {}),
            });
            event("ui_mapping_ok:accept");
            res.writeHead(303, { Location: `/w/${workspaceId}/imports/${importId}/mapping?notice=accepted` });
            res.end();
            return true;
          }
          failMapper(400, "Mapping failed", "Unknown mapper action. Use the propose or accept form.");
          return true;
        } catch (err) {
          if (err instanceof MappingError) {
            const message =
              err.code === "mapping_invalid" || err.code === "mapping_incomplete"
                ? `The mapping needs attention: ${(err.questions ?? []).map((q) => `${q.field} (${q.reason})`).join(", ") || "check the highlighted fields"}.`
                : err.code === "mapping_busy"
                  ? "A mapping call is already running for this import. Wait, then refresh."
                  : err.code === "permit_denied"
                    ? `AI policy changed (${err.reason ?? "revoked"}). The model-assisted result was not published; correct manually below.`
                    : "Check the values and retry.";
            const status = err.code === "invalid_request" ? 400 : 409;
            event("ui_mapping_denied");
            html(res, status, errorPage({ status, heading: status === 400 ? "Mapping failed" : "Mapping conflict", message, back: `/w/${workspaceId}/imports/${importId}/mapping`, requestId, authed: true }));
            return true;
          }
          if (err instanceof TenantDenied) {
            failMapper(404, "Not found", "No such workspace or import.");
            return true;
          }
          if (err instanceof TenantInvalid) {
            failMapper(400, "Mapping failed", "Check the highlighted fields and retry.");
            return true;
          }
          throw err;
        }
      }
      // GET: render current proposal, questions, sample preview, forms.
      const [current, sample, accounts, profiles] = await Promise.all([
        readCurrentMapping(pool, resolved.claim, importId).catch(() => null),
        loadMappingSample(pool, resolved.claim, importId).catch(() => null),
        listAccountViews(pool, resolved.claim).catch(() => []),
        listMappingProfiles(pool, resolved.claim).catch(() => []),
      ]);
      if (!sample) {
        failMapper(404, "Not found", "No such workspace or import.");
        return true;
      }
      const questions = current?.questions ?? [];
      const blockedFirst = questions[0]?.field;
      const autofocus = (field: string): string => (blockedFirst === field ? " autofocus" : "");
      const optionList = (names: string[], selected: string | undefined): string =>
        [`<option value="">—</option>`, ...names.map((n) => `<option value="${escapeHtml(n)}"${n === selected ? " selected" : ""}>${escapeHtml(n)}</option>`)].join("");
      const profile = current?.profile;
      const focusFor = (role: string): string => (role === "date" ? "date" : role === "amount" ? "amount" : role === "currency" ? "currency" : "columns");
      const colSelect = (role: string, label: string): string =>
        `<p><label for="map-${role}">${label}</label> <select id="map-${role}" name="col_${role}"${autofocus(focusFor(role))}>${optionList(sample.header, (profile?.columns as Record<string, string> | undefined)?.[role])}</select></p>`;
      const previewRows = sample.rows.slice(0, 10);
      const preview =
        previewRows.length === 0
          ? `<p>No staged rows to preview.</p>`
          : `<table><caption>Sample staged rows (first ${previewRows.length})</caption><thead><tr><th scope="col">Row</th>${sample.header.slice(0, 8).map((h) => `<th scope="col">${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${previewRows
              .map((cells, i) => `<tr><td>${i + 1}</td>${sample.header.slice(0, 8).map((h) => `<td>${escapeHtml(cells[h] ?? "")}</td>`).join("")}</tr>`)
              .join("")}</tbody></table>`;
      const questionList =
        questions.length === 0
          ? `<p>Validation: all mapped fields cohere with the staged sample.</p>`
          : `<div class="alert" role="alert"><h2>Needs attention (${questions.length})</h2><ul>${questions.map((q) => `<li><strong>${escapeHtml(q.field)}</strong> — ${escapeHtml(q.reason)}${q.detail ? `: ${escapeHtml(q.detail)}` : ""}</li>`).join("")}</ul></div>`;
      const savedList =
        profiles.length === 0
          ? `<p>No saved column profiles yet.</p>`
          : `<ul>${profiles.slice(0, 10).map((p) => `<li>${escapeHtml(p.name)} v${escapeHtml(p.version)} (${escapeHtml(p.createdFrom)})</li>`).join("")}</ul>`;
      const notice = query.get("notice") === "accepted" ? `<p>Mapping accepted.</p>` : ``;
      html(
        res,
        200,
        page({
          title: "Map import columns",
          requestId,
          authed: true,
          notice: notice || undefined,
          content: `<h2>Map columns</h2>${questionList}${preview}
            <form method="post" action="/w/${escapeHtml(workspaceId)}/imports/${escapeHtml(importId)}/mapping"><input type="hidden" name="action" value="propose"><p><label for="map-mode">Source</label> <select id="map-mode" name="mode"><option value="auto">Automatic (deterministic first, model only if needed)</option><option value="manual">Manual questions only</option></select></p><p><label><input type="checkbox" name="replace" value="1"> Replace the current proposal</label></p><p><button type="submit">Propose mapping</button></p></form>
            <form method="post" action="/w/${escapeHtml(workspaceId)}/imports/${escapeHtml(importId)}/mapping"><input type="hidden" name="action" value="accept"><input type="hidden" name="proposalId" value="${escapeHtml(current?.id ?? "")}"><input type="hidden" name="delimiter" value="${escapeHtml(sample.parseDelimiter)}">${colSelect("date", "Date column")}${colSelect("description", "Description column")}${colSelect("amount", "Amount column")}${colSelect("debit", "Debit column")}${colSelect("credit", "Credit column")}${colSelect("currency", "Currency column")}
            <p><label for="map-dateFormat">Date format</label> <select id="map-dateFormat" name="dateFormat"${autofocus("date")}>${["iso", "de", "us", "excel-serial"].map((f) => `<option${profile?.dateFormat === f ? " selected" : ""}>${f}</option>`).join("")}</select></p>
            <p><label for="map-kind">Amount kind</label> <select id="map-kind" name="kind"><option${(profile?.amount as { kind?: string } | undefined)?.kind !== "debit-credit" ? " selected" : ""}>signed</option><option${(profile?.amount as { kind?: string } | undefined)?.kind === "debit-credit" ? " selected" : ""}>debit-credit</option></select></p>
            <p><label for="map-decimalSep">Decimal separator</label> <select id="map-decimalSep" name="decimalSep"${autofocus("amount")}>${[".", ","].map((s) => `<option${(profile?.amount as { decimalSep?: string } | undefined)?.decimalSep === s ? " selected" : ""}>${s}</option>`).join("")}</select></p>
            <p><label for="map-thousandsSep">Thousands separator</label> <select id="map-thousandsSep" name="thousandsSep"><option value="">none</option>${[".", ","].map((s) => `<option value="${s}"${(profile?.amount as { thousandsSep?: string } | undefined)?.thousandsSep === s ? " selected" : ""}>${s}</option>`).join("")}</select></p>
            <p><label for="map-defaultCurrency">Default currency</label> <input id="map-defaultCurrency" name="defaultCurrency" maxlength="3" value="${escapeHtml(profile?.defaultCurrency ?? "")}"${autofocus("currency")}></p>
            <p><label for="map-accountId">Account</label> <select id="map-accountId" name="accountId"${autofocus("account")}><option value="">Automatic</option>${accounts.map((a) => `<option value="${escapeHtml(a.id)}"${current?.accountId === a.id ? " selected" : ""}>${escapeHtml(a.name)}</option>`).join("")}</select></p>
            <p><label for="map-saveAs">Save profile as (optional)</label> <input id="map-saveAs" name="saveAs" maxlength="120"></p>
            <p><button type="submit">Accept mapping</button></p></form>
            <h3>Saved profiles</h3>${savedList}
            <p><a href="/w/${escapeHtml(workspaceId)}/imports/${escapeHtml(importId)}">Back to import status</a></p>`,
        }),
      );
      return true;
    }

    return false;
  }

  return { handle: shell };
}

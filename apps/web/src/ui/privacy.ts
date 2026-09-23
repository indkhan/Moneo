// E08-S01 Privacy & Security page: server-rendered export request, package
// status and one-use download over the same domain functions the API uses
// (no parallel data path). Export creation/download require a fresh verified
// step-up; a stale step-up renders an explicit re-login page (403), foreign
// and missing packages render the uniform 404 page with no object bytes.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { isUuid } from "../ids.ts";
import {
  ExportError,
  acceptExportJob,
  exportErrorBody,
  listExports,
  loadExportConfig,
  serveExportDownload,
} from "../export.ts";
import { DeletionError, acceptDeletion, listDeletionMembers } from "../deletion.ts";
import { readLimitedBody } from "../http-controls.ts";
import { sessionClaims, type SessionResolver } from "../tenancy.ts";
import { errorPage, escapeHtml, page, workspaceNav } from "./shell.ts";

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

function packageRow(workspaceId: string, pkg: { id: string; status: string; cutoff: string; expiresAt: string; downloadedAt: string | null; sectionCounts: Record<string, number> | null; errorCode: string | null }): string {
  const counts = pkg.sectionCounts ? Object.entries(pkg.sectionCounts).map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(String(v))}`).join(", ") : "building";
  const action =
    pkg.status === "READY" && !pkg.downloadedAt
      ? ` <a href="/w/${escapeHtml(workspaceId)}/privacy/download?packageId=${escapeHtml(pkg.id)}">Download (one use)</a>`
      : pkg.status === "READY"
        ? " (already downloaded)"
        : "";
  return `<tr><td>${escapeHtml(pkg.status)}${pkg.errorCode ? ` (${escapeHtml(pkg.errorCode)})` : ""}</td><td>${escapeHtml(pkg.cutoff)}</td><td>${escapeHtml(pkg.expiresAt)}</td><td>${escapeHtml(counts)}</td><td>${action}</td></tr>`;
}

export async function handlePrivacyRoutes(
  pool: Pool,
  resolveSession: SessionResolver,
  opts: { appBaseUrl: string },
  event: (code: string) => void,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  query: URLSearchParams,
  requestId = "uncontrolled",
): Promise<boolean> {
  const privacyMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/privacy$/);
  if (privacyMatch && (method === "GET" || method === "POST")) {
    const workspaceId = privacyMatch[1];
    if (method === "GET") {
      const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
      if (!resolved.session) {
        html(res, 200, page({ title: "Privacy & Security", requestId, authed: false, content: `<p>Sign in to manage privacy for this workspace.</p><p><a href="/auth/login">Log in</a></p>` }));
        return true;
      }
      if (!resolved.claim) {
        html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
        return true;
      }
      let packages: Awaited<ReturnType<typeof listExports>> = [];
      let exportsDisabled = false;
      try {
        const config = loadExportConfig();
        packages = await listExports(pool, resolved.claim, config.s3);
      } catch {
        exportsDisabled = true;
      }
      const notice = query.get("notice");
      const noticeLine =
        notice === "requested"
          ? `<div class="notice" role="status"><p>Export requested. Refresh this page for readiness; the package expires 24 hours after creation and downloads once.</p></div>`
          : notice === "step-up"
            ? `<div class="alert" role="alert"><h2>Fresh sign-in required</h2><p>Exports need a sign-in within the last 5 minutes. <a href="/auth/login">Sign in again</a>, then retry.</p></div>`
            : notice === "deleted"
              ? `<div class="notice" role="status"><p>Deletion completed.</p></div>`
              : notice === "successor"
                ? `<div class="alert" role="alert"><h2>Successor required</h2><p>You are the only owner. Choose an existing member as successor owner, or have another member delete the workspace.</p></div>`
              : "";
      const form = exportsDisabled
        ? `<p>Exports are temporarily disabled.</p>`
        : `<form method="post" action="/w/${escapeHtml(workspaceId)}/privacy"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><p><button type="submit">Request workspace export</button></p><p><small>Requires a sign-in within the last 5 minutes. The package contains your workspace finance data plus only your own conversations/activity; other members' private data and secrets are excluded.</small></p></form>`;
      const rows = packages.length === 0 ? `<p>No export packages yet.</p>` : `<table><thead><tr><th scope="col">Status</th><th scope="col">Cutoff</th><th scope="col">Expires</th><th scope="col">Sections</th><th scope="col">Download</th></tr></thead><tbody>${packages.map((p) => packageRow(workspaceId, p)).join("")}</tbody></table>`;
      // E08-S01b deletion section: owners may delete the workspace; any
      // member may delete their own identity in it (sole owners must name a
      // successor; sole members purge the workspace). Both are irreversible
      // once the purge starts and require a fresh sign-in.
      let deletionSection = "";
      try {
        if (process.env["DELETIONS_ENABLED"] !== "1") throw new Error("disabled");
        const members = await listDeletionMembers(pool, resolved.claim);
        const mine = members.find((m) => m.user_id === resolved.claim!.userId);
        const others = members.filter((m) => m.user_id !== resolved.claim!.userId);
        const successorOptions = others.map((m) => `<option value="${escapeHtml(m.user_id)}">${escapeHtml(m.user_id.slice(0, 8))} (${escapeHtml(m.role)})</option>`).join("");
        const successorField =
          others.length > 0
            ? `<p><label for="del-successor">Successor owner (required if you are the only owner)</label> <select id="del-successor" name="successorUserId"><option value="">— none —</option>${successorOptions}</select></p>`
            : `<p><small>You are the only member: deleting your identity purges this workspace.</small></p>`;
        const workspaceForm =
          mine?.role === "owner"
            ? `<h4>Delete this workspace</h4><p>Purges all finance data, objects, jobs and memberships for every member. Irreversible once the purge starts.</p><form method="post" action="/w/${escapeHtml(workspaceId)}/privacy/delete"><input type="hidden" name="scope" value="workspace"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><p><label for="del-ws-confirm">Type DELETE to confirm</label> <input id="del-ws-confirm" name="confirm" required maxlength="16" autocomplete="off"></p><p><button type="submit">Delete workspace</button></p></form>`
            : "";
        deletionSection = `<h3>Delete</h3>${workspaceForm}<h4>Delete my identity in this workspace</h4><p>Removes your membership, sessions and personal content. Shared workspace finance stays available to remaining members.</p><form method="post" action="/w/${escapeHtml(workspaceId)}/privacy/delete"><input type="hidden" name="scope" value="identity"><input type="hidden" name="idempotencyKey" value="${randomUUID()}">${successorField}<p><label for="del-id-confirm">Type DELETE to confirm</label> <input id="del-id-confirm" name="confirm" required maxlength="16" autocomplete="off"></p><p><button type="submit">Delete my identity</button></p></form>`;
      } catch {
        deletionSection = `<h3>Delete</h3><p>Deletion is temporarily disabled.</p>`;
      }
      html(
        res,
        200,
        page({
          title: "Privacy & Security",
          requestId,
          authed: true,
          content: `<h2>Privacy &amp; Security</h2>${workspaceNav(workspaceId)}${noticeLine}<h3>Export workspace data</h3>${form}${rows}${deletionSection}<h3>Retention</h3><p>Original upload bytes are kept about 30 days after validated import; export packages expire after 24 hours. Backup, audit and processor timelines are set after hosting selection (E08-S01c gate) and shown here once approved.</p><p><a href="/w/${escapeHtml(workspaceId)}">Back to workspace</a></p>`,
        }),
      );
      return true;
    }
    // POST /w/:id/privacy — request an export package.
    if (!sameOrigin(req, opts.appBaseUrl)) {
      html(res, 403, errorPage({ status: 403, heading: "Forbidden", message: "Cross-origin form posts are rejected.", back: `/w/${workspaceId}/privacy`, requestId, authed: true }));
      return true;
    }
    try {
      loadExportConfig();
    } catch {
      try {
        await readFormBody(req);
      } catch { /* drain attempt; still hidden */ }
      html(res, 404, errorPage({ status: 404, heading: "Not found", message: "Exports are temporarily disabled.", back: `/w/${workspaceId}`, requestId, authed: true }));
      return true;
    }
    let form: URLSearchParams;
    try {
      form = await readFormBody(req);
    } catch {
      html(res, 400, errorPage({ status: 400, heading: "Export failed", message: "Invalid form data.", back: `/w/${workspaceId}/privacy`, requestId, authed: true }));
      return true;
    }
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.session) {
      html(res, 401, errorPage({ status: 401, heading: "Sign in required", message: "Sign in to request an export.", back: `/w/${workspaceId}/privacy`, requestId, authed: false }));
      return true;
    }
    if (!resolved.claim) {
      html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
      return true;
    }
    try {
      await acceptExportJob(pool, resolved.claim, resolved.claim.userId, resolved.session, { workspaceId, idempotencyKey: form.get("idempotencyKey") ?? "" });
      event("export_requested");
      res.writeHead(303, { Location: `/w/${workspaceId}/privacy?notice=requested` });
      res.end();
    } catch (err) {
      if (err instanceof ExportError) {
        const mapped = exportErrorBody(err);
        if (err.code === "step_up_required") {
          res.writeHead(303, { Location: `/w/${workspaceId}/privacy?notice=step-up` });
          res.end();
          return true;
        }
        html(res, mapped.status, errorPage({ status: mapped.status, heading: "Export failed", message: `Could not start export: ${err.code}.`, back: `/w/${workspaceId}/privacy`, requestId, authed: true }));
        return true;
      }
      throw err;
    }
    return true;
  }

  const deleteMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/privacy\/delete$/);
  if (deleteMatch && method === "POST") {
    const workspaceId = deleteMatch[1];
    if (!sameOrigin(req, opts.appBaseUrl)) {
      html(res, 403, errorPage({ status: 403, heading: "Forbidden", message: "Cross-origin form posts are rejected.", back: `/w/${workspaceId}/privacy`, requestId, authed: true }));
      return true;
    }
    if (process.env["DELETIONS_ENABLED"] !== "1") {
      try {
        await readFormBody(req);
      } catch { /* drain attempt; still hidden */ }
      html(res, 404, errorPage({ status: 404, heading: "Not found", message: "Deletion is temporarily disabled.", back: `/w/${workspaceId}/privacy`, requestId, authed: true }));
      return true;
    }
    let form: URLSearchParams;
    try {
      form = await readFormBody(req);
    } catch {
      html(res, 400, errorPage({ status: 400, heading: "Deletion failed", message: "Invalid form data.", back: `/w/${workspaceId}/privacy`, requestId, authed: true }));
      return true;
    }
    if (form.get("confirm") !== "DELETE") {
      html(res, 400, errorPage({ status: 400, heading: "Deletion failed", message: "Type DELETE exactly to confirm this irreversible action.", back: `/w/${workspaceId}/privacy`, requestId, authed: true }));
      return true;
    }
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.session) {
      html(res, 401, errorPage({ status: 401, heading: "Sign in required", message: "Sign in to request deletion.", back: `/w/${workspaceId}/privacy`, requestId, authed: false }));
      return true;
    }
    if (!resolved.claim) {
      html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
      return true;
    }
    const scope = form.get("scope") === "workspace" ? "workspace" : "identity";
    const successor = form.get("successorUserId");
    try {
      const result = await acceptDeletion(pool, resolved.claim, resolved.claim.userId, resolved.session, {
        workspaceId,
        scope,
        successorUserId: successor ? successor : null,
        idempotencyKey: form.get("idempotencyKey") ?? "",
      });
      event("deletion_requested");
      if (result.view.status === "COMPLETE") {
        res.writeHead(303, { Location: `/w/${workspaceId}/privacy?notice=deleted` });
        res.end();
        return true;
      }
      html(res, 502, errorPage({ status: 502, heading: "Deletion incomplete", message: `The request is ${result.view.status}. Retry with the same confirmation; partial failures stay visible.`, back: `/w/${workspaceId}/privacy`, requestId, authed: true }));
      return true;
    } catch (err) {
      if (err instanceof DeletionError) {
        if (err.code === "step_up_required") {
          res.writeHead(303, { Location: `/w/${workspaceId}/privacy?notice=step-up` });
          res.end();
          return true;
        }
        if (err.code === "successor_required") {
          res.writeHead(303, { Location: `/w/${workspaceId}/privacy?notice=successor` });
          res.end();
          return true;
        }
        const mapped = { status: err.code === "not_found" ? 404 : err.code === "forbidden" ? 403 : 409, body: null };
        html(res, mapped.status, errorPage({ status: mapped.status, heading: "Deletion failed", message: `Could not delete: ${err.code}.`, back: `/w/${workspaceId}/privacy`, requestId, authed: true }));
        return true;
      }
      throw err;
    }
    return true;
  }

  const downloadMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/privacy\/download$/);
  if (downloadMatch && method === "GET") {
    const workspaceId = downloadMatch[1];
    const packageId = query.get("packageId") ?? "";
    if (!isUuid(workspaceId) || !isUuid(packageId)) {
      html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such export.", back: "/", requestId, authed: true }));
      return true;
    }
    let config;
    try {
      config = loadExportConfig();
    } catch {
      html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such export.", back: `/w/${workspaceId}/privacy`, requestId, authed: true }));
      return true;
    }
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.session) {
      html(res, 401, errorPage({ status: 401, heading: "Sign in required", message: "Sign in to download.", back: `/w/${workspaceId}/privacy`, requestId, authed: false }));
      return true;
    }
    if (!resolved.claim) {
      html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such export.", back: "/", requestId, authed: true }));
      return true;
    }
    try {
      const download = await serveExportDownload(pool, config.s3, resolved.claim, resolved.claim.userId, resolved.session, packageId);
      if (!download) {
        html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such export. Packages download once and expire after 24 hours.", back: `/w/${workspaceId}/privacy`, requestId, authed: true }));
        return true;
      }
      event("export_downloaded");
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": download.bytes.byteLength,
        "Content-Disposition": `attachment; filename="${download.filename}"`,
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
      });
      res.end(download.bytes);
    } catch (err) {
      if (err instanceof ExportError && err.code === "step_up_required") {
        res.writeHead(303, { Location: `/w/${workspaceId}/privacy?notice=step-up` });
        res.end();
        return true;
      }
      throw err;
    }
    return true;
  }
  return false;
}

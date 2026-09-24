// E05-S05 artifact editor: server-rendered list/detail with
// Preview/Code/Data/Activity/Versions tabs, native forms for
// create/publish/activate, compact/full sandbox preview pages.
// Manual editing uses exactly S01 submit + S02 runtime + shared
// validators; never raw execution. No editor dependency.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { isUuid } from "../ids.ts";
import {
  withTenant,
  sessionClaims,
  enforceSessionBudget,
  SessionLimitError,
  TenantDenied,
  TenantInvalid,
  type SessionResolver,
} from "../tenancy.ts";
import {
  createArtifactDraft,
  submitArtifactBuild,
  getArtifactVersion,
  getArtifactVersionSource,
  settleArtifactVersion,
  listArtifactVersions,
  activateArtifactVersion,
  getArtifact,
  listArtifacts,
  renameArtifact,
} from "../commands/artifacts.ts";
import { getArtifactState } from "../commands/artifact-state.ts";
import { validateArtifactSource } from "../artifact-validate.ts";
import { readGrantBasis } from "../artifact-ai.ts";
import { createSessionRecord } from "../artifact-host.ts";
import { readLimitedBody } from "../http-controls.ts";
import { uuidv7 } from "../ids.ts";
import { errorPage, escapeHtml, page, workspaceNav } from "./shell.ts";
import { RENDERER_ORIGIN } from "../artifact-contract.ts";

function uiHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  });
  res.end(body);
}

function uiReadForm(req: IncomingMessage): Promise<URLSearchParams> {
  return readLimitedBody(req, 64 * 1024).then((body) => {
    try {
      return new URLSearchParams(body.toString("utf8"));
    } catch {
      throw new Error("body_invalid");
    }
  });
}

function uiSameOrigin(req: IncomingMessage, appBaseUrl: string): boolean {
  if (req.headers["sec-fetch-site"] === "same-origin") return true;
  const allowed = new URL(appBaseUrl).origin;
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  if (typeof origin === "string") return origin === allowed;
  if (typeof referer === "string") return referer === allowed || referer.startsWith(allowed + "/");
  return false;
}

function errorShell(
  res: ServerResponse,
  status: number,
  heading: string,
  message: string,
  back: string,
  requestId: string,
): void {
  uiHtml(res, status, errorPage({ status, heading, message, back, requestId, authed: true }));
}

function tabsNav(workspaceId: string, artifactId: string, active: string): string {
  const tabs = ["preview", "code", "data", "activity", "versions"];
  return (
    '<nav aria-label="Artifact sections"><ul>' +
    tabs
      .map((t) => {
        const label = t.charAt(0).toUpperCase() + t.slice(1);
        const current = t === active ? ' aria-current="page"' : "";
        return (
          '<li><a href="/w/' +
          escapeHtml(workspaceId) +
          "/artifacts/" +
          escapeHtml(artifactId) +
          "?tab=" +
          t +
          '"' +
          current +
          ">" +
          label +
          "</a></li>"
        );
      })
      .join("") +
    "</ul></nav>"
  );
}

const DEFAULT_MANIFEST = JSON.stringify(
  {
    artifactSdkVersion: "1",
    runtimeVersion: "1",
    sourceSchemaVersion: "1",
    stateSchemaVersion: "1",
    requestedPermissions: ["analytics.spending_by_category"],
    approvedPermissions: ["analytics.spending_by_category"],
    entrypoints: { full: "main", compact: "compact" },
    resourceBudget: { maxMessagesPerSecond: 100 },
    sourceHash: "",
    buildHash: "",
  },
  null,
  2,
);

const DEFAULT_HTML = "<section><h1>Monthly spending</h1><div data-slot=\"chart\"></div></section>";
const DEFAULT_CSS = "section{font:16px system-ui;padding:1rem}";
const DEFAULT_JS =
  "const rows = artifact.finance.spendingByCategory();\n" +
  "artifact.ui.render({ type: \"chart\", rows: rows });";

export async function handleArtifactRoutes(
  pool: Pool,
  resolveSession: SessionResolver,
  config: { appBaseUrl: string },
  event: (code: string) => void,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  query: URLSearchParams,
  requestId: string,
): Promise<boolean> {
  if (method !== "POST") req.resume();
  req.on("error", () => {});
  try {

  // --- List ---
  const listMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/artifacts$/);
  if (listMatch && method === "GET") {
    const workspaceId = listMatch[1];
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.session) {
      uiHtml(res, 401, errorPage({ status: 401, heading: "Sign in required", message: "Log in to view artifacts.", back: "/", requestId, authed: false }));
      return true;
    }
    if (!resolved.claim) {
      event("ui_denied:artifacts");
      uiHtml(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
      return true;
    }
    const claim = resolved.claim;
    const artifacts = await withTenant(pool, claim, (client) => listArtifacts(client, claim));
    const rows =
      artifacts.length === 0
        ? '<p>No artifacts yet. <a href="/w/' +
          escapeHtml(workspaceId) +
          '/artifacts/new">Create your first artifact</a>.</p>'
        : "<table><caption>Artifacts</caption><thead><tr><th scope=\"col\">Name</th><th scope=\"col\">Description</th><th scope=\"col\">Active</th><th scope=\"col\">Updated</th><th scope=\"col\">Open</th></tr></thead><tbody>" +
          artifacts
            .map(
              (a) =>
                "<tr><td>" +
                escapeHtml(a.name) +
                "</td><td>" +
                escapeHtml(a.description ?? "") +
                "</td><td>" +
                (a.activeVersionId ? "v" + escapeHtml(a.activeVersionId.slice(0, 8)) : "\u2014") +
                "</td><td>" +
                escapeHtml(a.updatedAt) +
                "</td><td><a href=\"/w/" +
                escapeHtml(workspaceId) +
                "/artifacts/" +
                escapeHtml(a.artifactId) +
                "?tab=preview\">Open</a></td></tr>",
            )
            .join("") +
          "</tbody></table>";
    uiHtml(
      res,
      200,
      page({
        title: "Artifacts",
        requestId,
        authed: true,
        content:
          workspaceNav(workspaceId) +
          '<p><a href="/w/' +
          escapeHtml(workspaceId) +
          '/artifacts/new">Create new artifact</a> · <a href="/w/' +
          escapeHtml(workspaceId) +
          '">Back to workspace</a></p>' +
          rows,
      }),
    );
    return true;
  }

  // --- New form ---
  const newMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/artifacts\/new$/);
  if (newMatch && method === "GET") {
    const resolved = await sessionClaims(pool, resolveSession, req, newMatch[1]);
    if (!resolved.session) {
      uiHtml(res, 401, errorPage({ status: 401, heading: "Sign in required", message: "Log in to create artifacts.", back: "/", requestId, authed: false }));
      return true;
    }
    if (!resolved.claim) {
      uiHtml(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
      return true;
    }
    uiHtml(
      res,
      200,
      page({
        title: "New artifact",
        requestId,
        authed: true,
        content:
          '<form method="post" action="/w/' +
          escapeHtml(newMatch[1]) +
          '/artifacts">' +
          '<p><label for="art-name">Name</label> <input id="art-name" name="name" required maxlength="200"></p>' +
          '<p><label for="art-desc">Description (optional)</label> <input id="art-desc" name="description" maxlength="500"></p>' +
          '<p><button type="submit">Create draft</button></p></form>' +
          '<p><a href="/w/' +
          escapeHtml(newMatch[1]) +
          '/artifacts">Back to artifacts</a></p>',
      }),
    );
    return true;
  }

  // --- Create draft (form) ---
  const createMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/artifacts$/);
  if (createMatch && method === "POST") {
    const workspaceId = createMatch[1];
    if (!uiSameOrigin(req, config.appBaseUrl)) {
      event("ui_denied:origin");
      uiHtml(res, 403, errorPage({ status: 403, heading: "Forbidden", message: "Cross-origin form posts are rejected.", back: "/w/" + workspaceId + "/artifacts", requestId, authed: true }));
      return true;
    }
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.claim) {
      const authed = resolved.session !== null;
      uiHtml(res, authed ? 404 : 401, errorPage({ status: authed ? 404 : 401, heading: authed ? "Not found" : "Sign in required", message: "No such workspace.", back: "/", requestId, authed }));
      return true;
    }
    const claim = resolved.claim;
    const form = await uiReadForm(req).catch(() => null);
    const name = form?.get("name") ?? "";
    const description = form?.get("description") ?? "";
    if (!name || name.length > 200 || description.length > 500) {
      uiHtml(res, 400, errorPage({ status: 400, heading: "Create failed", message: "Name is required (1-200 chars); description at most 500 chars.", back: "/w/" + workspaceId + "/artifacts/new", requestId, authed: true }));
      return true;
    }
    const { artifactId } = await withTenant(pool, claim, (client) => createArtifactDraft(client, claim, name, description || undefined));
    event("ui_artifact_ok:create");
    res.writeHead(303, { Location: "/w/" + workspaceId + "/artifacts/" + artifactId + "?tab=code" });
    res.end();
    return true;
  }

  // --- Detail with tabs ---
  const detailMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/artifacts\/([A-Za-z0-9-]+)$/);
  if (detailMatch && method === "GET") {
    const workspaceId = detailMatch[1];
    const artifactId = detailMatch[2];
    // E05 adversarial fix round 2: malformed ids 404, never UUID-cast 500.
    if (!isUuid(artifactId)) {
      errorShell(res, 404, "Not found", "No such workspace or artifact.", "/", requestId);
      return true;
    }
    const tab = query.get("tab") ?? "preview";
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.session) {
      uiHtml(res, 401, errorPage({ status: 401, heading: "Sign in required", message: "Log in to view artifacts.", back: "/", requestId, authed: false }));
      return true;
    }
    if (!resolved.claim) {
      event("ui_denied:artifacts");
      uiHtml(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace or artifact.", back: "/", requestId, authed: true }));
      return true;
    }
    const claim = resolved.claim;
    const artifact = await withTenant(pool, claim, (client) => getArtifact(client, claim, artifactId));
    if (!artifact) {
      uiHtml(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such artifact.", back: "/w/" + workspaceId + "/artifacts", requestId, authed: true }));
      return true;
    }
    const versions = await withTenant(pool, claim, (client) => listArtifactVersions(client, claim, artifactId));
    const latest = versions[0];
    const active = artifact.activeVersionId ? versions.find((v) => v.versionId === artifact.activeVersionId) : undefined;
    const notice =
      query.get("notice") === "published"
        ? "Version published and validated."
        : query.get("notice") === "validated"
          ? "Source validates. Publish to create a version."
          : query.get("notice") === "renamed"
            ? "Artifact renamed."
            : query.get("notice") === "activated"
              ? "Version activated."
              : query.get("notice") === "failed"
                ? "Build failed; active version unchanged. Fix the highlighted error below."
                : undefined;

    let tabBody = "";
    if (tab === "code") {
      // Prefill from latest version source when available, else defaults.
      let htmlSrc = DEFAULT_HTML;
      let cssSrc = DEFAULT_CSS;
      let jsSrc = DEFAULT_JS;
      let manifestSrc = DEFAULT_MANIFEST;
      if (latest) {
        const src = await withTenant(pool, claim, (client) =>
          import("../commands/artifacts.ts").then((m) => m.getArtifactVersionSource(client, claim, artifactId, latest.versionId)),
        );
        if (src) {
          htmlSrc = src.html;
          cssSrc = src.css;
          jsSrc = src.js;
        }
        const ver = await withTenant(pool, claim, (client) => getArtifactVersion(client, claim, artifactId, latest.versionId));
        if (ver) manifestSrc = JSON.stringify(ver.manifest, null, 2);
      }
      const err = query.get("error");
      const errBlock = err
        ? '<div class="alert" role="alert"><h2>Build needs attention</h2><p>' + escapeHtml(err) + '</p></div>'
        : "";
      tabBody =
        errBlock +
        '<form method="post" action="/w/' +
        escapeHtml(workspaceId) +
        "/artifacts/" +
        escapeHtml(artifactId) +
        '/versions">' +
        '<input type="hidden" name="expectedBaseVersionId" value="' +
        escapeHtml(latest?.versionId ?? "") +
        '">' +
        '<p><label for="code-html">artifact.html</label><textarea id="code-html" name="html" rows="10" cols="80" required>' +
        escapeHtml(htmlSrc) +
        "</textarea></p>" +
        '<p><label for="code-css">artifact.css</label><textarea id="code-css" name="css" rows="6" cols="80" required>' +
        escapeHtml(cssSrc) +
        "</textarea></p>" +
        '<p><label for="code-js">artifact.js</label><textarea id="code-js" name="js" rows="12" cols="80" required>' +
        escapeHtml(jsSrc) +
        "</textarea></p>" +
        '<p><label for="code-manifest">artifact.manifest.json</label><textarea id="code-manifest" name="manifest" rows="12" cols="80" required>' +
        escapeHtml(manifestSrc) +
        "</textarea></p>" +
        "<p>Permissions allowed in R1: balances.read, analytics.cashflow, analytics.spending_by_category, transactions.summary.read. Raw descriptions, SQL, network, DOM and eval/Function are rejected.</p>" +
        '<p><button type="submit" name="action" value="validate">Validate only</button> <button type="submit" name="action" value="publish">Validate and publish</button></p></form>';
    } else if (tab === "data") {
      const state = await withTenant(pool, claim, (client) =>
        import("../commands/artifact-state.ts").then((m) => m.getArtifactState(client, claim, artifactId)),
      );
      const manifest = active
        ? await withTenant(pool, claim, (client) => getArtifactVersion(client, claim, artifactId, active.versionId))
        : latest
          ? await withTenant(pool, claim, (client) => getArtifactVersion(client, claim, artifactId, latest.versionId))
          : null;
      const perms = manifest ? (manifest.manifest.approvedPermissions as string[]).map(escapeHtml).join(", ") : "\u2014";
      tabBody =
        "<h3>Permissions</h3><p>" +
        perms +
        "</p><h3>Local state</h3>" +
        (state
          ? "<p>Schema v" +
            escapeHtml(String(state.schemaVersion)) +
            " · updated " +
            escapeHtml(state.updatedAt) +
            '</p><pre><code>' +
            escapeHtml(JSON.stringify(state.state, null, 2).slice(0, 4000)) +
            "</code></pre>"
          : "<p>No local state saved yet. Interacting with the artifact saves bounded JSON here (max 64 KiB).</p>");
    } else if (tab === "activity") {
      tabBody =
        versions.length === 0
          ? "<p>No activity yet.</p>"
          : "<table><caption>Build activity</caption><thead><tr><th scope=\"col\">Version</th><th scope=\"col\">Status</th><th scope=\"col\">Created</th><th scope=\"col\">Settled</th></tr></thead><tbody>" +
            versions
              .slice(0, 20)
              .map(
                (v) =>
                  "<tr><td>" +
                  escapeHtml(v.versionId.slice(0, 8)) +
                  "</td><td>" +
                  escapeHtml(v.status) +
                  "</td><td>" +
                  escapeHtml(v.createdAt) +
                  "</td><td>" +
                  (v.settledAt ? escapeHtml(v.settledAt) : "\u2014") +
                  "</td></tr>",
              )
              .join("") +
            "</tbody></table><p>SDK access events are recorded per runtime grant (method, counts, denial class); no code or finance values are logged.</p>";
    } else if (tab === "versions") {
      tabBody =
        versions.length === 0
          ? "<p>No versions yet.</p>"
          : "<table><caption>Version history (newest first, max 100)</caption><thead><tr><th scope=\"col\">Version</th><th scope=\"col\">Status</th><th scope=\"col\">Source hash</th><th scope=\"col\">By</th><th scope=\"col\">Created</th><th scope=\"col\">Activate</th></tr></thead><tbody>" +
            versions
              .slice(0, 100)
              .map(
                (v) =>
                  "<tr><td>" +
                  escapeHtml(v.versionId.slice(0, 8)) +
                  (artifact.activeVersionId === v.versionId ? " (active)" : "") +
                  "</td><td>" +
                  escapeHtml(v.status) +
                  "</td><td><code>" +
                  escapeHtml(v.sourceHash.slice(0, 12)) +
                  "</code></td><td>" +
                  escapeHtml(v.createdBy ?? "\u2014") +
                  "</td><td>" +
                  escapeHtml(v.createdAt) +
                  "</td><td>" +
                  (v.status === "ready" && artifact.activeVersionId !== v.versionId
                    ? '<form method="post" action="/w/' +
                      escapeHtml(workspaceId) +
                      "/artifacts/" +
                      escapeHtml(artifactId) +
                      '/activate"><input type="hidden" name="versionId" value="' +
                      escapeHtml(v.versionId) +
                      '"><input type="hidden" name="expectedActiveVersionId" value="' +
                      escapeHtml(artifact.activeVersionId ?? "") +
                      '"><button type="submit">Activate this version</button></form>'
                    : "\u2014") +
                  "</td></tr>",
              )
              .join("") +
            "</tbody></table><p>Reverting means activating a previous ready version; old code never runs against newer state. Hashes are server-computed SHA-256 over the exact submitted source.</p>";
    } else {
      // preview tab (default)
      const target = active ?? latest;
      tabBody = target
        ? '<p>Active' +
          (active ? "" : " (latest, not yet activated)") +
          ": v" +
          escapeHtml(target.versionId.slice(0, 8)) +
          " (" +
          escapeHtml(target.status) +
          "). Preview runs in the production-equivalent sandbox (separate origin, CSP, terminable worker).</p>" +
          (target.status === "ready"
            ? '<p><a href="/w/' +
              escapeHtml(workspaceId) +
              "/artifacts/" +
              escapeHtml(artifactId) +
              "/versions/" +
              escapeHtml(target.versionId) +
              '/compact">Open compact preview</a> · <a href="/w/' +
              escapeHtml(workspaceId) +
              "/artifacts/" +
              escapeHtml(artifactId) +
              "/versions/" +
              escapeHtml(target.versionId) +
              '/full">Open full preview</a></p><p>Runaway preview stays stoppable from the preview page Stop control.</p>'
            : "<p>This version is still building or failed; open the Versions tab for status.</p>")
        : "<p>No versions yet. Use the Code tab to write and publish your first version.</p>";
    }

    uiHtml(
      res,
      200,
      page({
        title: artifact.name,
        requestId,
        authed: true,
        notice,
        content:
          workspaceNav(workspaceId) +
          "<h2>" +
          escapeHtml(artifact.name) +
          (artifact.description ? " \u2014 " + escapeHtml(artifact.description) : "") +
          "</h2>" +
          '<details><summary>Rename artifact</summary><form method="post" action="/w/' +
          escapeHtml(workspaceId) +
          "/artifacts/" +
          escapeHtml(artifactId) +
          '/rename"><input type="hidden" name="expectedUpdatedAt" value="' +
          escapeHtml(artifact.updatedAt) +
          '"><p><label for="art-rename-name">Name</label> <input id="art-rename-name" name="name" required maxlength="200" value="' +
          escapeHtml(artifact.name) +
          '"></p><p><label for="art-rename-desc">Description</label> <input id="art-rename-desc" name="description" maxlength="500" value="' +
          escapeHtml(artifact.description ?? "") +
          '"></p><p><button type="submit">Save name</button></p></form></details>' +
          tabsNav(workspaceId, artifactId, tab) +
          '<section aria-label="' +
          escapeHtml(tab) +
          '">' +
          tabBody +
          "</section>" +
          '<p><a href="/w/' +
          escapeHtml(workspaceId) +
          '/artifacts">Back to artifacts</a></p>',
      }),
    );
    return true;
  }

  // --- Publish new version (form) ---
  const publishMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/artifacts\/([A-Za-z0-9-]+)\/versions$/);
  if (publishMatch && method === "POST") {
    const workspaceId = publishMatch[1];
    const artifactId = publishMatch[2];
    // E05 adversarial fix round 2: malformed ids 404, never UUID-cast 500.
    if (!isUuid(artifactId)) {
      errorShell(res, 404, "Not found", "No such workspace or artifact.", "/", requestId);
      return true;
    }
    if (!uiSameOrigin(req, config.appBaseUrl)) {
      event("ui_denied:origin");
      uiHtml(res, 403, errorPage({ status: 403, heading: "Forbidden", message: "Cross-origin form posts are rejected.", back: "/w/" + workspaceId + "/artifacts/" + artifactId + "?tab=code", requestId, authed: true }));
      return true;
    }
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.claim) {
      const authed = resolved.session !== null;
      uiHtml(res, authed ? 404 : 401, errorPage({ status: authed ? 404 : 401, heading: authed ? "Not found" : "Sign in required", message: "No such workspace or artifact.", back: "/", requestId, authed }));
      return true;
    }
    const claim = resolved.claim;
    const form = await uiReadForm(req).catch(() => null);
    const htmlSrc = form?.get("html") ?? "";
    const cssSrc = form?.get("css") ?? "";
    const jsSrc = form?.get("js") ?? "";
    const manifestRaw = form?.get("manifest") ?? "";
    const expectedBase = form?.get("expectedBaseVersionId") ?? "";
    if (!htmlSrc || !cssSrc || !jsSrc || !manifestRaw) {
      event("ui_artifact_denied:publish");
      uiHtml(res, 400, errorPage({ status: 400, heading: "Publish failed", message: "All four source files (html, css, js, manifest) are required.", back: "/w/" + workspaceId + "/artifacts/" + artifactId + "?tab=code", requestId, authed: true }));
      return true;
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestRaw);
    } catch {
      event("ui_artifact_denied:publish");
      const back = "/w/" + workspaceId + "/artifacts/" + artifactId + "?tab=code&error=" + encodeURIComponent("Manifest is not valid JSON; source preserved below. Reopen the Code tab to fix it.");
      uiHtml(res, 400, errorPage({ status: 400, heading: "Publish failed", message: "Manifest is not valid JSON. Your source was preserved; reopen the Code tab to fix it.", back, requestId, authed: true }));
      return true;
    }
    const action = form?.get("action") ?? "publish";
    if (action === "validate") {
      const { validateArtifactSource } = await import("../artifact-validate.ts");
      const check = validateArtifactSource({ html: htmlSrc, css: cssSrc, js: jsSrc }, manifest);
      event(check.ok ? "ui_artifact_ok:validate" : "ui_artifact_denied:validate");
      if (check.ok) {
        res.writeHead(303, { Location: "/w/" + workspaceId + "/artifacts/" + artifactId + "?tab=code&notice=validated" });
        res.end();
        return true;
      }
      uiHtml(
        res,
        400,
        page({
          title: "Validation result",
          requestId,
          authed: true,
          content:
            '<div class="alert" role="alert"><h2>Validation failed</h2><p>' +
            escapeHtml(check.errorClass + ": " + check.errorMessage) +
            "</p><p>No version was created; the active artifact is unchanged. Your source is preserved below.</p></div>" +
            "<h3>Submitted source (preserved)</h3>" +
            "<h4>artifact.html</h4><pre><code>" +
            escapeHtml(htmlSrc) +
            "</code></pre><h4>artifact.css</h4><pre><code>" +
            escapeHtml(cssSrc) +
            "</code></pre><h4>artifact.js</h4><pre><code>" +
            escapeHtml(jsSrc) +
            "</code></pre>" +
            '<p><a href="/w/' +
            escapeHtml(workspaceId) +
            "/artifacts/" +
            escapeHtml(artifactId) +
            '?tab=code">Back to Code tab</a></p>',
        }),
      );
      return true;
    }
    try {
      const outcome = await withTenant(pool, claim, async (client) => {
        const existing = await listArtifactVersions(client, claim, artifactId);
        const latestId = existing[0]?.versionId ?? "";
        if (expectedBase && latestId !== expectedBase) {
          const e = new Error("VERSION_MISMATCH") as Error & { currentVersion?: string };
          (e as { currentVersion?: string }).currentVersion = latestId;
          throw e;
        }
        const { versionId } = await submitArtifactBuild(
          client,
          claim,
          artifactId,
          { html: htmlSrc, css: cssSrc, js: jsSrc },
          manifest as import("../commands/artifacts.ts").ArtifactManifest,
        );
        const { validateArtifactSource } = await import("../artifact-validate.ts");
        const check = validateArtifactSource({ html: htmlSrc, css: cssSrc, js: jsSrc }, manifest);
        const { settleArtifactVersion } = await import("../commands/artifacts.ts");
        if (check.ok) {
          await settleArtifactVersion(client, claim, artifactId, versionId, { ok: true });
          return { versionId, status: "ready" as const, error: undefined as string | undefined };
        }
        await settleArtifactVersion(client, claim, artifactId, versionId, { ok: false, errorClass: check.errorClass, errorMessage: check.errorMessage });
        return { versionId, status: "failed" as const, error: check.errorClass + ":" + check.errorMessage };
      });
      if (outcome.status === "failed") {
        event("ui_artifact_denied:publish");
        res.writeHead(303, {
          Location: "/w/" + workspaceId + "/artifacts/" + artifactId + "?tab=code&notice=failed&error=" + encodeURIComponent(outcome.error ?? "build_failed"),
        });
        res.end();
        return true;
      }
      event("ui_artifact_ok:publish");
      res.writeHead(303, { Location: "/w/" + workspaceId + "/artifacts/" + artifactId + "?tab=versions&notice=published" });
      res.end();
      return true;
    } catch (err) {
      if (err instanceof Error && err.message === "VERSION_MISMATCH") {
        event("ui_artifact_conflict:publish");
        uiHtml(
          res,
          409,
          page({
            title: "Publish conflict",
            requestId,
            authed: true,
            content:
              '<div class="alert" role="alert"><h2>Stale base version</h2><p>Another version was published first. Your source was preserved below; copy it, reload the Code tab for the fresh base, and retry.</p></div>' +
              "<h3>Your submitted source (preserved)</h3>" +
              "<h4>artifact.html</h4><pre><code>" +
              escapeHtml(htmlSrc) +
              "</code></pre><h4>artifact.css</h4><pre><code>" +
              escapeHtml(cssSrc) +
              "</code></pre><h4>artifact.js</h4><pre><code>" +
              escapeHtml(jsSrc) +
              "</code></pre>" +
              '<p><a href="/w/' +
              escapeHtml(workspaceId) +
              "/artifacts/" +
              escapeHtml(artifactId) +
              '?tab=code">Reload Code tab</a></p>',
          }),
        );
        return true;
      }
      if (err instanceof TenantDenied) {
        event("ui_denied:artifacts");
        uiHtml(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace or artifact.", back: "/", requestId, authed: true }));
        return true;
      }
      throw err;
    }
  }

  // --- Rename (form, optimistic expectedUpdatedAt) ---
  const renameMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/artifacts\/([A-Za-z0-9-]+)\/rename$/);
  if (renameMatch && method === "POST") {
    const workspaceId = renameMatch[1];
    const artifactId = renameMatch[2];
    // E05 adversarial fix round 2: malformed ids 404, never UUID-cast 500.
    if (!isUuid(artifactId)) {
      errorShell(res, 404, "Not found", "No such workspace or artifact.", "/", requestId);
      return true;
    }
    if (!uiSameOrigin(req, config.appBaseUrl)) {
      event("ui_denied:origin");
      uiHtml(res, 403, errorPage({ status: 403, heading: "Forbidden", message: "Cross-origin form posts are rejected.", back: "/w/" + workspaceId + "/artifacts/" + artifactId + "?tab=preview", requestId, authed: true }));
      return true;
    }
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.claim) {
      const authed = resolved.session !== null;
      uiHtml(res, authed ? 404 : 401, errorPage({ status: authed ? 404 : 401, heading: authed ? "Not found" : "Sign in required", message: "No such workspace or artifact.", back: "/", requestId, authed }));
      return true;
    }
    const claim = resolved.claim;
    const form = await uiReadForm(req).catch(() => null);
    const name = form?.get("name") ?? "";
    const description = form?.get("description") ?? "";
    const expectedUpdatedAt = form?.get("expectedUpdatedAt") ?? "";
    if (!name || name.length > 200 || description.length > 500 || !expectedUpdatedAt) {
      uiHtml(res, 400, errorPage({ status: 400, heading: "Rename failed", message: "Name is required (1-200 chars); description at most 500 chars.", back: "/w/" + workspaceId + "/artifacts/" + artifactId + "?tab=preview", requestId, authed: true }));
      return true;
    }
    try {
      const { renameArtifact } = await import("../commands/artifacts.ts");
      await withTenant(pool, claim, (client) => renameArtifact(client, claim, artifactId, name, description || undefined, expectedUpdatedAt));
      event("ui_artifact_ok:rename");
      res.writeHead(303, { Location: "/w/" + workspaceId + "/artifacts/" + artifactId + "?tab=preview&notice=renamed" });
      res.end();
      return true;
    } catch (err) {
      if (err instanceof Error && (err.message === "VERSION_MISMATCH" || err.message === "ARTIFACT_NOT_FOUND")) {
        event("ui_artifact_conflict:rename");
        uiHtml(res, err.message === "VERSION_MISMATCH" ? 409 : 404, errorPage({ status: err.message === "VERSION_MISMATCH" ? 409 : 404, heading: "Rename conflict", message: "The artifact changed. Reload and retry with the fresh values.", back: "/w/" + workspaceId + "/artifacts/" + artifactId + "?tab=preview", requestId, authed: true }));
        return true;
      }
      if (err instanceof Error && (err.message === "INVALID_NAME" || err.message === "INVALID_DESCRIPTION")) {
        uiHtml(res, 400, errorPage({ status: 400, heading: "Rename failed", message: "Check name (1-200) and description (≤500) and retry.", back: "/w/" + workspaceId + "/artifacts/" + artifactId + "?tab=preview", requestId, authed: true }));
        return true;
      }
      throw err;
    }
  }

  // --- Activate (form) ---
  const activateMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/artifacts\/([A-Za-z0-9-]+)\/activate$/);
  if (activateMatch && method === "POST") {
    const workspaceId = activateMatch[1];
    const artifactId = activateMatch[2];
    // E05 adversarial fix round 2: malformed ids 404, never UUID-cast 500.
    if (!isUuid(artifactId)) {
      errorShell(res, 404, "Not found", "No such workspace or artifact.", "/", requestId);
      return true;
    }
    if (!uiSameOrigin(req, config.appBaseUrl)) {
      event("ui_denied:origin");
      uiHtml(res, 403, errorPage({ status: 403, heading: "Forbidden", message: "Cross-origin form posts are rejected.", back: "/w/" + workspaceId + "/artifacts/" + artifactId + "?tab=versions", requestId, authed: true }));
      return true;
    }
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.claim) {
      const authed = resolved.session !== null;
      uiHtml(res, authed ? 404 : 401, errorPage({ status: authed ? 404 : 401, heading: authed ? "Not found" : "Sign in required", message: "No such workspace or artifact.", back: "/", requestId, authed }));
      return true;
    }
    const claim = resolved.claim;
    const form = await uiReadForm(req).catch(() => null);
    const versionId = form?.get("versionId") ?? "";
    const expected = form?.get("expectedActiveVersionId") ?? "";
    if (!isUuid(versionId)) {
      uiHtml(res, 400, errorPage({ status: 400, heading: "Activate failed", message: "Invalid version.", back: "/w/" + workspaceId + "/artifacts/" + artifactId + "?tab=versions", requestId, authed: true }));
      return true;
    }
    try {
      await withTenant(pool, claim, (client) => activateArtifactVersion(client, claim, artifactId, versionId, expected || undefined));
      event("ui_artifact_ok:activate");
      res.writeHead(303, { Location: "/w/" + workspaceId + "/artifacts/" + artifactId + "?tab=versions&notice=activated" });
      res.end();
      return true;
    } catch (err) {
      if (err instanceof Error && (err.message === "VERSION_MISMATCH" || err.message === "VERSION_NOT_READY" || err.message === "VERSION_NOT_FOUND" || err.message === "ARTIFACT_NOT_FOUND")) {
        event("ui_artifact_conflict:activate");
        uiHtml(res, err.message === "VERSION_NOT_READY" ? 409 : 404, errorPage({ status: err.message === "VERSION_NOT_READY" ? 409 : 404, heading: "Activate failed", message: "Version changed or is not ready. Reload Versions and retry.", back: "/w/" + workspaceId + "/artifacts/" + artifactId + "?tab=versions", requestId, authed: true }));
        return true;
      }
      throw err;
    }
  }

  // --- Compact / full preview ---
  const viewMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/artifacts\/([A-Za-z0-9-]+)\/versions\/([A-Za-z0-9-]+)\/(compact|full)$/);
  if (viewMatch && method === "GET") {
    const workspaceId = viewMatch[1];
    const artifactId = viewMatch[2];
    const versionId = viewMatch[3];
    // E05 adversarial fix round 2: malformed ids 404, never UUID-cast 500.
    if (!isUuid(artifactId) || !isUuid(versionId)) {
      errorShell(res, 404, "Not found", "No such workspace, artifact or version.", "/", requestId);
      return true;
    }
    const mode = viewMatch[4];
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.session) {
      uiHtml(res, 401, errorPage({ status: 401, heading: "Sign in required", message: "Log in to preview artifacts.", back: "/", requestId, authed: false }));
      return true;
    }
    if (!resolved.claim) {
      event("ui_denied:artifacts");
      uiHtml(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace, artifact or version.", back: "/", requestId, authed: true }));
      return true;
    }
    const claim = resolved.claim;
    const version = await withTenant(pool, claim, (client) => getArtifactVersion(client, claim, artifactId, versionId));
    if (!version || version.status !== "ready") {
      uiHtml(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such ready artifact version.", back: "/w/" + workspaceId + "/artifacts/" + artifactId + "?tab=versions", requestId, authed: true }));
      return true;
    }
    const source = await withTenant(pool, claim, (client) =>
      import("../commands/artifacts.ts").then((m) => m.getArtifactVersionSource(client, claim, artifactId, versionId)),
    );
    if (!source) {
      uiHtml(res, 404, errorPage({ status: 404, heading: "Not found", message: "Source for this version is unavailable (pre-editor build).", back: "/w/" + workspaceId + "/artifacts/" + artifactId + "?tab=versions", requestId, authed: true }));
      return true;
    }
    const stateRow = await withTenant(pool, claim, (client) =>
      import("../commands/artifact-state.ts").then((m) => m.getArtifactState(client, claim, artifactId)),
    );
    // Server session + grant: the browser attaches the iframe; every finance
    // RPC is rechecked against this grant (expiry, policy/data freshness,
    // permissions) before any query runs. The session budget is enforced
    // inside the creation transaction via the shared helper (same gate as
    // POST /api/artifacts/sessions, so neither door bypasses the other).
    let opened: { sessionId: string; nonce: string };
    try {
      opened = await withTenant(pool, claim, async (client) => {
        await enforceSessionBudget(client, claim.workspaceId, claim.userId);
        const sessionId = uuidv7();
      const contractManifest = {
        ...version.manifest,
        createdAt: version.createdAt,
      } as import("../artifact-contract.ts").ArtifactManifest;
      const session = createSessionRecord({
        sessionId,
        workspaceId: claim.workspaceId,
        userId: claim.userId,
        artifactId,
        artifactVersionId: versionId,
        approvedPermissions: (version.manifest.approvedPermissions ?? []) as string[],
        source,
        manifest: contractManifest,
        initialState: (stateRow?.state ?? {}) as Record<string, unknown>,
      });
      const basis = await readGrantBasis(client, claim.workspaceId);
      await client.query(
        `INSERT INTO artifact_runtime_grants (workspace_id, id, artifact_id, artifact_version_id, user_id, session_id, permissions, data_revision, policy_revision, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + interval '30 minutes')`,
        [claim.workspaceId, uuidv7(), artifactId, versionId, claim.userId, sessionId, version.manifest.approvedPermissions ?? [], basis.dataRevision, basis.policyVersion],
      );
      return session;
      });
    } catch (err) {
      if (err instanceof SessionLimitError) {
        event("ui_artifact_denied:session_limit");
        uiHtml(res, 429, errorPage({ status: 429, heading: "Too many open previews", message: "Close a preview (Stop) before opening another.", back: "/w/" + workspaceId + "/artifacts/" + artifactId + "?tab=preview", requestId, authed: true }));
        return true;
      }
      throw err;
    }
    const width = mode === "compact" ? "320" : "800";
    const height = mode === "compact" ? "240" : "600";
    const nonce = opened.nonce;
    const sessionId = opened.sessionId;
    const iframeSrc = RENDERER_ORIGIN + "/artifact-renderer.html?session=" + encodeURIComponent(nonce);
    const manifestJson = JSON.stringify(version.manifest).replace(/</g, "\\u003c");
    const sourceJson = JSON.stringify(source).replace(/</g, "\\u003c");
    const stateJson = JSON.stringify(stateRow?.state ?? {}).replace(/</g, "\\u003c");
    const otherMode = mode === "compact" ? "full" : "compact";
    const otherHref = "/w/" + workspaceId + "/artifacts/" + artifactId + "/versions/" + versionId + "/" + otherMode;
    const backHref = "/w/" + workspaceId + "/artifacts/" + artifactId + "?tab=preview";
    uiHtml(
      res,
      200,
      page({
        title: mode === "compact" ? "Artifact preview (compact)" : "Artifact preview (full)",
        requestId,
        authed: true,
        content:
          '<p><a href="' +
          escapeHtml(backHref) +
          '">Back to artifact</a> · <a href="' +
          escapeHtml(otherHref) +
          '">Switch to ' +
          otherMode +
          '</a> · v' +
          escapeHtml(versionId.slice(0, 8)) +
          "</p>" +
          '<div role="status" aria-live="polite" id="art-status">Loading preview…</div>' +
          '<p><button type="button" id="art-stop">Stop preview</button> <button type="button" id="art-restart">Restart preview</button></p>' +
          '<iframe id="art-frame" title="Artifact preview (' +
          mode +
          ')" src="' +
          escapeHtml(iframeSrc) +
          '" width="' +
          width +
          '" height="' +
          height +
          '" sandbox="allow-scripts allow-same-origin" style="border:1px solid #666;max-width:100%;"></iframe>' +
          "<script>" +
          "(function(){" +
          "var frame=document.getElementById('art-frame');" +
          "var status=document.getElementById('art-status');" +
          "var stopBtn=document.getElementById('art-stop');" +
          "var restartBtn=document.getElementById('art-restart');" +
          "var channel=new MessageChannel();" +
          "var nonce=" +
          JSON.stringify(nonce) +
          ";" +
          "var source=" +
          sourceJson +
          ";" +
          "var manifest=" +
          manifestJson +
          ";" +
          "var state=" +
          stateJson +
          ";" +
          "var stopped=false;" +
          "function setStatus(t){status.textContent=t;}" +
          "stopBtn.addEventListener('click',function(){stopped=true;try{channel.port1.postMessage({type:'stop',protocol:1,nonce:nonce});}catch(e){}setStatus('Preview stopped.');});" +
          "restartBtn.addEventListener('click',function(){location.reload();});" +
          "frame.addEventListener('load',function(){" +
          "try{frame.contentWindow.postMessage({type:'connect',protocol:1,nonce:nonce}," +
          JSON.stringify(RENDERER_ORIGIN) +
          ",[channel.port2]);}catch(e){setStatus('Preview failed to connect.');return;}" +
          "channel.port1.onmessage=function(e){" +
          "var d=e.data||{};" +
          "if(d.type==='status'){setStatus('Preview: '+d.value);}" +
          "if(d.type==='status'&&d.value==='ready'&&!stopped){" +
          "channel.port1.postMessage({type:'start',protocol:1,nonce:nonce,source:source,state:state,finance:{categories:[],cashflow:[],balances:[],transactionSummary:[]},manifest:manifest});" +
          "}" +
          "if(d.type==='rpc_request'&&!stopped){" +
          "var r=d.value||{};" +
          "fetch('/api/artifacts/sdk/rpc',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({sessionId:" +
          JSON.stringify(sessionId) +
          ",method:r.method,args:r.args})}).then(function(resp){return resp.json().then(function(body){return {ok:resp.ok,body:body};});}).then(function(out){" +
          "if(out.ok){channel.port1.postMessage({type:'rpc_response',value:{requestId:r.requestId,result:out.body.result},protocol:1,nonce:nonce});}" +
          "else{channel.port1.postMessage({type:'rpc_response',value:{requestId:r.requestId,error:(out.body&&out.body.error)||'rpc_failed'},protocol:1,nonce:nonce});}" +
          "}).catch(function(err){channel.port1.postMessage({type:'rpc_response',value:{requestId:r.requestId,error:String(err&&err.message||err)},protocol:1,nonce:nonce});});" +
          "}" +
          "};" +
          "setStatus('Preview connected; starting sandbox…');" +
          "});" +
          "})();<" +
          "/script>",
      }),
    );
    return true;
  }

  return false;
  } catch (err) {
    if (err instanceof TenantDenied) {
      event("ui_denied:artifacts");
      uiHtml(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace or artifact.", back: "/", requestId, authed: true }));
      return true;
    }
    if (err instanceof TenantInvalid) {
      uiHtml(res, 400, errorPage({ status: 400, heading: "Request failed", message: "Check the values and retry.", back: "/", requestId, authed: true }));
      return true;
    }
    throw err;
  }
}
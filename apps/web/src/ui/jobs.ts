// E07-S04 navigation + job feedback: durable job list, per-user notices and
// the exact-route palette. Server-rendered, zero client JavaScript (the R1
// shell contract): native links/buttons/forms, strict escaping, manual
// Refresh always available. The only "live" behavior is an opt-in
// `?auto=1` meta-refresh (progressive enhancement, GET only): every load
// re-derives notices from PostgreSQL truth idempotently, so refresh never
// duplicates notices and never restarts work. No realtime service, no search
// index, no broad object search — the palette resolves exact route names
// only. Stop/retry appears only where the owning domain permits it, using
// the existing commands (cancelJob, analysis stop/retry, chat stop/retry).

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { isUuid } from "../ids.ts";
import { cancelJob } from "../job-recovery.ts";
import { TenantDenied, sessionClaims, withTenant, type SessionResolver } from "../tenancy.ts";
import { listNotices, markNoticeRead, syncNoticesForTerminalJobs, type NoticeView } from "../notices.ts";
import { readLimitedBody } from "../http-controls.ts";
import { errorPage, escapeHtml, page, workspaceNav } from "./shell.ts";

export type JobsUiConfig = { appBaseUrl: string };

export const JOBS_PAGE_LIMIT = 50;

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

function parseOffset(query: URLSearchParams): number | null {
  const raw = query.get("offset");
  if (raw === null || raw === "") return 0;
  if (!/^\d+$/.test(raw)) return null;
  return Math.min(1_000_000, Number(raw));
}

// ---- PostgreSQL job reads (durable truth; never queue state alone) ----

export type JobListRow = {
  id: string;
  jobType: string;
  jobVersion: string;
  status: string;
  attemptCount: string;
  progressStage: string | null;
  errorCode: string | null;
  inputRef: { importId?: string; threadId?: string; runId?: string } | null;
  resultRef: { importId?: string } | null;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type AttemptRow = {
  attemptNo: number;
  generation: string;
  worker: string;
  checkpointStage: string | null;
  status: string;
  startedAt: string;
  heartbeatAt: string | null;
  completedAt: string | null;
};

const ERROR_CLASS_RE = /^[A-Za-z0-9_.-]{1,64}$/;

function safeError(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  return ERROR_CLASS_RE.test(raw) ? raw : "unknown_error";
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function asInputRef(raw: unknown): JobListRow["inputRef"] {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  const out: { importId?: string; threadId?: string; runId?: string } = {};
  if (typeof v.importId === "string" && isUuid(v.importId)) out.importId = v.importId;
  if (typeof v.threadId === "string" && isUuid(v.threadId)) out.threadId = v.threadId;
  if (typeof v.runId === "string" && isUuid(v.runId)) out.runId = v.runId;
  return out;
}

export async function listJobs(
  pool: Pool,
  claims: { userId: string; workspaceId: string },
  opts?: { limit?: number; offset?: number },
): Promise<{ jobs: JobListRow[]; total: number }> {
  const limit = opts?.limit ?? JOBS_PAGE_LIMIT;
  const offset = opts?.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > JOBS_PAGE_LIMIT) throw new TenantDenied();
  if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) throw new TenantDenied();
  return withTenant(pool, claims, async (client) => {
    const total = await client.query("SELECT count(*)::int AS n FROM background_jobs WHERE workspace_id = $1", [claims.workspaceId]);
    const rows = await client.query(
      "SELECT id, job_type, job_version, status, attempt_count, progress_stage, error_code, input_ref, result_ref, queued_at, started_at, completed_at FROM background_jobs WHERE workspace_id = $1 ORDER BY queued_at DESC, id DESC LIMIT $2 OFFSET $3",
      [claims.workspaceId, limit, offset],
    );
    return {
      total: (total.rows[0] as { n: number }).n,
      jobs: (rows.rows as Record<string, unknown>[]).map((r) => {
        const row = r as {
          id: string;
          job_type: string;
          job_version: string;
          status: string;
          attempt_count: string;
          progress_stage: string | null;
          error_code: string | null;
          input_ref: unknown;
          result_ref: unknown;
          queued_at: unknown;
          started_at: unknown;
          completed_at: unknown;
        };
        const resultRef = typeof row.result_ref === "object" && row.result_ref !== null ? (row.result_ref as { importId?: string }) : null;
        return {
          id: row.id,
          jobType: row.job_type,
          jobVersion: row.job_version,
          status: row.status,
          attemptCount: String(row.attempt_count),
          progressStage: typeof row.progress_stage === "string" ? row.progress_stage : null,
          errorCode: safeError(row.error_code),
          inputRef: asInputRef(row.input_ref),
          resultRef: resultRef && typeof resultRef.importId === "string" && isUuid(resultRef.importId) ? { importId: resultRef.importId } : null,
          queuedAt: iso(row.queued_at) ?? String(row.queued_at),
          startedAt: iso(row.started_at),
          completedAt: iso(row.completed_at),
        };
      }),
    };
  });
}

export async function readJobDetail(
  pool: Pool,
  claims: { userId: string; workspaceId: string },
  jobId: string,
): Promise<{ job: JobListRow; attempts: AttemptRow[]; resultKind: string | null } | null> {
  if (!isUuid(jobId)) return null;
  return withTenant(pool, claims, async (client) => {
    const found = await client.query(
      "SELECT id, job_type, job_version, status, attempt_count, progress_stage, error_code, input_ref, result_ref, queued_at, started_at, completed_at FROM background_jobs WHERE workspace_id = $1 AND id = $2",
      [claims.workspaceId, jobId],
    );
    if ((found.rowCount ?? 0) === 0) return null;
    const row = found.rows[0] as {
      id: string;
      job_type: string;
      job_version: string;
      status: string;
      attempt_count: string;
      progress_stage: string | null;
      error_code: string | null;
      input_ref: unknown;
      result_ref: unknown;
      queued_at: unknown;
      started_at: unknown;
      completed_at: unknown;
    };
    const resultRef = typeof row.result_ref === "object" && row.result_ref !== null ? (row.result_ref as { importId?: string }) : null;
    const job: JobListRow = {
      id: row.id,
      jobType: row.job_type,
      jobVersion: row.job_version,
      status: row.status,
      attemptCount: String(row.attempt_count),
      progressStage: typeof row.progress_stage === "string" ? row.progress_stage : null,
      errorCode: safeError(row.error_code),
      inputRef: asInputRef(row.input_ref),
      resultRef: resultRef && typeof resultRef.importId === "string" && isUuid(resultRef.importId) ? { importId: resultRef.importId } : null,
      queuedAt: iso(row.queued_at) ?? String(row.queued_at),
      startedAt: iso(row.started_at),
      completedAt: iso(row.completed_at),
    };
    const attempts = await client.query(
      "SELECT attempt_no, generation, worker_instance_id, checkpoint_stage, status, started_at, heartbeat_at, completed_at FROM background_job_attempts WHERE workspace_id = $1 AND background_job_id = $2 ORDER BY attempt_no",
      [claims.workspaceId, jobId],
    );
    const result = await client.query("SELECT result_kind FROM background_job_results WHERE workspace_id = $1 AND background_job_id = $2", [
      claims.workspaceId,
      jobId,
    ]);
    return {
      job,
      attempts: (attempts.rows as Record<string, unknown>[]).map((r) => {
        const a = r as {
          attempt_no: number;
          generation: string;
          worker_instance_id: string;
          checkpoint_stage: string | null;
          status: string;
          started_at: unknown;
          heartbeat_at: unknown;
          completed_at: unknown;
        };
        return {
          attemptNo: Number(a.attempt_no),
          generation: String(a.generation),
          worker: String(a.worker_instance_id),
          checkpointStage: typeof a.checkpoint_stage === "string" ? a.checkpoint_stage : null,
          status: String(a.status),
          startedAt: iso(a.started_at) ?? String(a.started_at),
          heartbeatAt: iso(a.heartbeat_at),
          completedAt: iso(a.completed_at),
        };
      }),
      resultKind: (result.rowCount ?? 0) > 0 ? String((result.rows[0] as { result_kind: string }).result_kind) : null,
    };
  });
}

// ---- Authorized result/evidence links (tenant-safe existing URLs only) ----

export type JobLinks = { primary: { href: string; label: string } | null; recovery: { href: string; label: string } | null };

async function targetExists(pool: Pool, claims: { userId: string; workspaceId: string }, table: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const allowed = new Set(["imports", "chat_threads", "artifacts"]);
  if (!allowed.has(table)) return false;
  return withTenant(pool, claims, async (client) => {
    const found = await client.query(`SELECT 1 FROM ${table} WHERE workspace_id = $1 AND id = $2`, [claims.workspaceId, id]);
    return (found.rowCount ?? 0) > 0;
  });
}

export async function jobLinks(pool: Pool, claims: { userId: string; workspaceId: string }, job: JobListRow): Promise<JobLinks> {
  const w = claims.workspaceId;
  const inputImport = job.inputRef?.importId ?? job.resultRef?.importId ?? null;
  if ((job.jobType === "imports.parse" || job.jobType === "imports.commit") && inputImport) {
    const ok = await targetExists(pool, claims, "imports", inputImport);
    if (!ok) return { primary: null, recovery: { href: `/w/${w}/imports/new`, label: "Start a fresh upload" } };
    if (job.jobType === "imports.commit") {
      return {
        primary: { href: `/w/${w}/imports/${inputImport}`, label: "Open import" },
        recovery:
          job.status === "FAILED_FINAL"
            ? { href: `/w/${w}/imports/${inputImport}/mapping`, label: "Review mapping and retry" }
            : null,
      };
    }
    return {
      primary: { href: `/w/${w}/imports/${inputImport}`, label: "Open import" },
      recovery:
        job.status === "FAILED_FINAL" ? { href: `/w/${w}/imports/new`, label: "Start a fresh upload" } : null,
    };
  }
  if (job.jobType === "deep-analysis.run") {
    return {
      primary: { href: `/w/${w}/analysis`, label: "Open Deep Analysis" },
      recovery: job.status === "FAILED_FINAL" || job.status === "CANCELLED" ? { href: `/w/${w}/analysis`, label: "Retry analysis" } : null,
    };
  }
  if (job.jobType === "chat.generate" && job.inputRef?.threadId) {
    const ok = await targetExists(pool, claims, "chat_threads", job.inputRef.threadId);
    if (!ok) return { primary: null, recovery: { href: `/w/${w}/chat`, label: "Back to conversations" } };
    return {
      primary: { href: `/w/${w}/chat/${job.inputRef.threadId}`, label: "Open conversation" },
      recovery:
        job.status === "FAILED_FINAL" || job.status === "CANCELLED"
          ? { href: `/w/${w}/chat/${job.inputRef.threadId}`, label: "Retry the turn" }
          : null,
    };
  }
  return { primary: { href: `/w/${w}/jobs/${job.id}`, label: "Open job" }, recovery: null };
}

// ---- Exact-route palette (no broad object search) ----

export const PALETTE_ROUTES: { name: string; label: string; path: (workspaceId: string) => string }[] = [
  { name: "home", label: "Home dashboard", path: (w) => `/w/${w}/home` },
  { name: "money", label: "Money (transactions)", path: (w) => `/w/${w}/transactions` },
  { name: "plan", label: "Plan (planning inputs)", path: (w) => `/w/${w}/planning` },
  { name: "goals", label: "Plan — goals", path: (w) => `/w/${w}/goals` },
  { name: "projection", label: "Plan — projection", path: (w) => `/w/${w}/projection` },
  { name: "scenarios", label: "Plan — scenarios", path: (w) => `/w/${w}/scenarios` },
  { name: "ai", label: "AI (conversations)", path: (w) => `/w/${w}/chat` },
  { name: "analysis", label: "AI — Deep Analysis", path: (w) => `/w/${w}/analysis` },
  { name: "library", label: "AI — Library (artifacts)", path: (w) => `/w/${w}/artifacts` },
  { name: "jobs", label: "Jobs", path: (w) => `/w/${w}/jobs` },
  { name: "notices", label: "Notices", path: (w) => `/w/${w}/notices` },
  { name: "imports", label: "Import a bank file", path: (w) => `/w/${w}/imports/new` },
  { name: "workspace", label: "Workspace overview", path: (w) => `/w/${w}` },
];

export function resolvePaletteRoute(workspaceId: string, raw: string): string | null {
  const name = raw.trim().toLowerCase();
  if (!name) return null;
  const hit = PALETTE_ROUTES.find((r) => r.name === name);
  return hit ? hit.path(workspaceId) : null;
}

// ---- Small presenters ----

function statusBadge(status: string): string {
  const labels: Record<string, string> = {
    QUEUED: "queued",
    RUNNING: "running",
    SUCCEEDED: "completed",
    FAILED_FINAL: "failed",
    CANCEL_REQUESTED: "running",
    CANCELLED: "cancelled",
  };
  return `<span class="badge ${labels[status] ?? ""}">${escapeHtml(status)}</span>`;
}

function jobTypeLabel(jobType: string): string {
  const labels: Record<string, string> = {
    "imports.start": "Import",
    "imports.parse": "Import parse",
    "imports.commit": "Import commit",
    "chat.generate": "Assistant reply",
    "artifact.build": "Artifact build",
    "deep-analysis.run": "Deep Analysis",
  };
  return labels[jobType] ?? jobType;
}

export function renderNoticeItem(workspaceId: string, notice: NoticeView, inert: boolean): string {
  const state = notice.readAt ? "read" : "unread";
  const link = notice.linkHref && !inert ? `<a href="${escapeHtml(notice.linkHref)}">Open</a>` : `<span>no longer available</span>`;
  return `<li><strong>${escapeHtml(notice.title)}</strong> (${escapeHtml(notice.kind)}, ${escapeHtml(state)}) — ${escapeHtml(notice.body)} ${link}${
    notice.readAt
      ? ``
      : `<form method="post" action="/w/${escapeHtml(workspaceId)}/notices/${escapeHtml(notice.id)}/read" style="display:inline"><button type="submit">Mark read</button></form>`
  }</li>`;
}

export async function handleNavigationJobsRoutes(
  pool: Pool,
  resolveSession: SessionResolver,
  config: JobsUiConfig,
  event: (code: string) => void,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  query: URLSearchParams,
  requestId = "uncontrolled",
): Promise<boolean> {
  // ---- GET /w/:id/go (exact-route palette; POST never needed) ----
  const goMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/go$/);
  if (goMatch && method === "GET") {
    const workspaceId = goMatch[1];
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.session) {
      html(res, 401, errorPage({ status: 401, heading: "Sign in required", message: "Log in to navigate.", back: "/", requestId, authed: false }));
      return true;
    }
    if (!resolved.claim) {
      event("ui_denied:workspace");
      html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
      return true;
    }
    const to = query.get("to");
    if (to !== null) {
      const dest = resolvePaletteRoute(workspaceId, to);
      if (dest) {
        res.writeHead(303, { Location: dest });
        res.end();
        return true;
      }
      html(
        res,
        404,
        page({
          title: "Jump to",
          requestId,
          authed: true,
          content: `${workspaceNav(workspaceId)}<h2>Jump to</h2><div class="alert" role="alert"><h2>Unknown destination</h2><p>No exact route matches “${escapeHtml(to.slice(0, 80))}”. Choose one below — the palette resolves exact route names only.</p></div>${paletteForm(workspaceId, to)}${paletteLinks(workspaceId)}`,
        }),
      );
      return true;
    }
    html(
      res,
      200,
      page({
        title: "Jump to",
        requestId,
        authed: true,
        content: `${workspaceNav(workspaceId)}<h2>Jump to</h2><p>Type an exact route name (home, money, plan, ai, jobs, notices, …). Escape never submits or leaves this page; Clear empties the field; Back returns to the workspace.</p>${paletteForm(workspaceId, "")}${paletteLinks(workspaceId)}`,
      }),
    );
    return true;
  }

  // ---- GET /w/:id/jobs (durable list; sync-then-read recovery) ----
  const jobsMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/jobs$/);
  if (jobsMatch && method === "GET") {
    const workspaceId = jobsMatch[1];
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.session) {
      html(res, 401, errorPage({ status: 401, heading: "Sign in required", message: "Log in to view jobs.", back: "/", requestId, authed: false }));
      return true;
    }
    if (!resolved.claim) {
      event("ui_denied:workspace");
      html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
      return true;
    }
    const offset = parseOffset(query);
    if (offset === null) {
      html(res, 400, errorPage({ status: 400, heading: "Invalid page", message: "The page offset is not valid. Return to the first page and retry.", back: `/w/${workspaceId}/jobs`, requestId, authed: true }));
      return true;
    }
    try {
      await syncNoticesForTerminalJobs(pool, resolved.claim, resolved.claim.userId).catch(() => ({ created: 0 }));
      const { jobs, total } = await listJobs(pool, resolved.claim, { limit: JOBS_PAGE_LIMIT, offset });
      const auto = query.get("auto") === "1";
      const rows =
        jobs.length === 0
          ? `<p>No background jobs yet. Imports, assistant replies and Deep Analysis runs appear here.</p>`
          : `<div style="overflow-x:auto"><table><caption>Background jobs (PostgreSQL truth; newest first)</caption><thead><tr><th scope="col">Job</th><th scope="col">Status</th><th scope="col">Attempts</th><th scope="col">Queued</th><th scope="col">Open</th></tr></thead><tbody>${jobs
              .map(
                (j) =>
                  `<tr><td>${escapeHtml(jobTypeLabel(j.jobType))}${j.errorCode ? ` (${escapeHtml(j.errorCode)})` : ""}</td><td>${statusBadge(j.status)}</td><td>${escapeHtml(j.attemptCount)}</td><td>${escapeHtml(j.queuedAt)}</td><td><a href="/w/${escapeHtml(workspaceId)}/jobs/${escapeHtml(j.id)}">Open</a></td></tr>`,
              )
              .join("")}</tbody></table></div>`;
      const pager = `<p>${total === 0 ? "" : `Showing ${offset + 1}–${Math.min(total, offset + jobs.length)} of ${total}. `}${offset > 0 ? `<a href="/w/${escapeHtml(workspaceId)}/jobs?offset=${Math.max(0, offset - JOBS_PAGE_LIMIT)}${auto ? "&amp;auto=1" : ""}">Previous page</a> ` : ""}${offset + jobs.length < total ? `<a href="/w/${escapeHtml(workspaceId)}/jobs?offset=${offset + JOBS_PAGE_LIMIT}${auto ? "&amp;auto=1" : ""}">Next page</a>` : ""}</p>`;
      const refresh = `<form method="get" action="/w/${escapeHtml(workspaceId)}/jobs">${auto ? `<input type="hidden" name="auto" value="1">` : ""}<button type="submit">Refresh</button></form>`;
      const autoToggle = auto
        ? `<p>Auto-refresh on (every 30 seconds; manual Refresh always works). <a href="/w/${escapeHtml(workspaceId)}/jobs">Turn off</a></p>`
        : `<p><a href="/w/${escapeHtml(workspaceId)}/jobs?auto=1">Turn on auto-refresh</a> (every 30 seconds; manual Refresh always works).</p>`;
      const meta = auto ? `<meta http-equiv="refresh" content="30">` : ``;
      html(
        res,
        200,
        page({
          title: "Jobs",
          requestId,
          authed: true,
          content: `${meta}${workspaceNav(workspaceId)}<h2>Jobs</h2><div role="status" aria-live="polite"><p>${total} job(s) known. State reloads from PostgreSQL on every view — missed queue events recover here.</p></div>${refresh}${autoToggle}${rows}${pager}`,
        }),
      );
    } catch (err) {
      if (err instanceof TenantDenied) {
        event("ui_denied:workspace");
        html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
        return true;
      }
      throw err;
    }
    return true;
  }

  // ---- GET /w/:id/jobs/:jobId (detail + attempts + authorized links) ----
  const jobDetailMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/jobs\/([A-Za-z0-9-]+)$/);
  if (jobDetailMatch && method === "GET") {
    const workspaceId = jobDetailMatch[1];
    const jobId = jobDetailMatch[2];
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.session) {
      html(res, 401, errorPage({ status: 401, heading: "Sign in required", message: "Log in to view jobs.", back: "/", requestId, authed: false }));
      return true;
    }
    if (!resolved.claim) {
      event("ui_denied:workspace");
      html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
      return true;
    }
    try {
      const detail = await readJobDetail(pool, resolved.claim, jobId);
      if (!detail) {
        html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such job.", back: `/w/${workspaceId}/jobs`, requestId, authed: true }));
        return true;
      }
      const { job, attempts, resultKind } = detail;
      const links = await jobLinks(pool, resolved.claim, job);
      const active = job.status === "QUEUED" || job.status === "RUNNING" || job.status === "CANCEL_REQUESTED";
      const failed = job.status === "FAILED_FINAL";
      const stopForm = active
        ? `<form method="post" action="/w/${escapeHtml(workspaceId)}/jobs/${escapeHtml(job.id)}/cancel"><button type="submit">Stop job</button></form>`
        : ``;
      const evidence = [
        links.primary ? `<a href="${escapeHtml(links.primary.href)}">${escapeHtml(links.primary.label)}</a>` : `Result target no longer available`,
        links.recovery ? `<a href="${escapeHtml(links.recovery.href)}">${escapeHtml(links.recovery.label)}</a>` : ``,
      ]
        .filter(Boolean)
        .join(" · ");
      const attemptRows =
        attempts.length === 0
          ? `<p>No attempts recorded yet.</p>`
          : `<div style="overflow-x:auto"><table><caption>Attempt history</caption><thead><tr><th scope="col">Attempt</th><th scope="col">Generation</th><th scope="col">Status</th><th scope="col">Checkpoint</th><th scope="col">Started</th></tr></thead><tbody>${attempts
              .map(
                (a) =>
                  `<tr><td>${escapeHtml(String(a.attemptNo))}</td><td>${escapeHtml(a.generation)}</td><td>${escapeHtml(a.status)}</td><td>${escapeHtml(a.checkpointStage ?? "—")}</td><td>${escapeHtml(a.startedAt)}</td></tr>`,
              )
              .join("")}</tbody></table></div>`;
      const failure = failed
        ? `<div class="alert" role="alert"><h2>Job failed${job.errorCode ? ` (${escapeHtml(job.errorCode)})` : ""}</h2><p>Safe recovery: ${evidence}. Raw payloads are never shown.</p></div>`
        : `<p>Result: ${evidence}.</p>`;
      html(
        res,
        200,
        page({
          title: "Job detail",
          requestId,
          authed: true,
          content: `${workspaceNav(workspaceId)}<h2>${escapeHtml(jobTypeLabel(job.jobType))}</h2><p>Status: ${statusBadge(job.status)} · version ${escapeHtml(job.jobVersion)} · attempts ${escapeHtml(job.attemptCount)}${job.progressStage ? ` · stage ${escapeHtml(job.progressStage)}` : ""}${resultKind ? ` · result ${escapeHtml(resultKind)}` : ""}.</p><p>Queued ${escapeHtml(job.queuedAt)}${job.startedAt ? ` · started ${escapeHtml(job.startedAt)}` : ""}${job.completedAt ? ` · completed ${escapeHtml(job.completedAt)}` : ""}.</p>${failure}${stopForm}${attemptRows}<p><a href="/w/${escapeHtml(workspaceId)}/jobs">Back to jobs</a></p>`,
        }),
      );
    } catch (err) {
      if (err instanceof TenantDenied) {
        event("ui_denied:workspace");
        html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
        return true;
      }
      throw err;
    }
    return true;
  }

  // ---- POST /w/:id/jobs/:jobId/cancel (existing domain command) ----
  const jobCancelMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/jobs\/([A-Za-z0-9-]+)\/cancel$/);
  if (jobCancelMatch && method === "POST") {
    const workspaceId = jobCancelMatch[1];
    const jobId = jobCancelMatch[2];
    if (!sameOrigin(req, config.appBaseUrl)) {
      event("ui_denied:origin");
      html(res, 403, errorPage({ status: 403, heading: "Forbidden", message: "Cross-origin form posts are rejected.", back: `/w/${workspaceId}/jobs`, requestId, authed: true }));
      return true;
    }
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.session || !resolved.claim) {
      html(res, resolved.session ? 404 : 401, errorPage({ status: resolved.session ? 404 : 401, heading: resolved.session ? "Not found" : "Sign in required", message: "No such workspace or job.", back: "/", requestId, authed: !!resolved.session }));
      return true;
    }
    try {
      const outcome = await cancelJob(pool, resolved.claim, jobId);
      if (!outcome) {
        html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such job.", back: `/w/${workspaceId}/jobs`, requestId, authed: true }));
        return true;
      }
      event("ui_job_cancel_ok");
      res.writeHead(303, { Location: `/w/${workspaceId}/jobs/${jobId}` });
      res.end();
    } catch (err) {
      if (err instanceof TenantDenied) {
        html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such job.", back: `/w/${workspaceId}/jobs`, requestId, authed: true }));
        return true;
      }
      throw err;
    }
    return true;
  }

  // ---- GET /w/:id/notices (sync-then-read; 50/page) ----
  const noticesMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/notices$/);
  if (noticesMatch && method === "GET") {
    const workspaceId = noticesMatch[1];
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.session) {
      html(res, 401, errorPage({ status: 401, heading: "Sign in required", message: "Log in to view notices.", back: "/", requestId, authed: false }));
      return true;
    }
    if (!resolved.claim) {
      event("ui_denied:workspace");
      html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
      return true;
    }
    const offset = parseOffset(query);
    if (offset === null) {
      html(res, 400, errorPage({ status: 400, heading: "Invalid page", message: "The page offset is not valid. Return to the first page and retry.", back: `/w/${workspaceId}/notices`, requestId, authed: true }));
      return true;
    }
    try {
      await syncNoticesForTerminalJobs(pool, resolved.claim, resolved.claim.userId).catch(() => ({ created: 0 }));
      const { notices, total, unread } = await listNotices(pool, resolved.claim, resolved.claim.userId, { limit: 50, offset });
      const items =
        notices.length === 0
          ? `<p>No notices yet. Completed or failed import, analysis, chat or artifact work appears here once — even after reload or queue event loss.</p>`
          : `<ul>${(await Promise.all(notices.map(async (n) => renderNoticeItem(workspaceId, n, await noticeLinkDead(pool, resolved.claim!, n))))).join("")}</ul>`;
      const pager = `<p>${total === 0 ? "" : `Showing ${offset + 1}–${Math.min(total, offset + notices.length)} of ${total} (${unread} unread). `}${offset > 0 ? `<a href="/w/${escapeHtml(workspaceId)}/notices?offset=${Math.max(0, offset - 50)}">Previous page</a> ` : ""}${offset + notices.length < total ? `<a href="/w/${escapeHtml(workspaceId)}/notices?offset=${offset + 50}">Next page</a>` : ""}</p>`;
      html(
        res,
        200,
        page({
          title: "Notices",
          requestId,
          authed: true,
          content: `${workspaceNav(workspaceId)}<h2>Notices</h2><div role="status" aria-live="polite"><p>${unread} unread of ${total}.</p></div><form method="get" action="/w/${escapeHtml(workspaceId)}/notices"><button type="submit">Refresh</button></form>${items}${pager}`,
        }),
      );
    } catch (err) {
      if (err instanceof TenantDenied) {
        event("ui_denied:workspace");
        html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such workspace.", back: "/", requestId, authed: true }));
        return true;
      }
      throw err;
    }
    return true;
  }

  // ---- POST /w/:id/notices/:noticeId/read ----
  const noticeReadMatch = path.match(/^\/w\/([A-Za-z0-9-]+)\/notices\/([A-Za-z0-9-]+)\/read$/);
  if (noticeReadMatch && method === "POST") {
    const workspaceId = noticeReadMatch[1];
    const noticeId = noticeReadMatch[2];
    if (!sameOrigin(req, config.appBaseUrl)) {
      event("ui_denied:origin");
      html(res, 403, errorPage({ status: 403, heading: "Forbidden", message: "Cross-origin form posts are rejected.", back: `/w/${workspaceId}/notices`, requestId, authed: true }));
      return true;
    }
    const resolved = await sessionClaims(pool, resolveSession, req, workspaceId);
    if (!resolved.session || !resolved.claim) {
      html(res, resolved.session ? 404 : 401, errorPage({ status: resolved.session ? 404 : 401, heading: resolved.session ? "Not found" : "Sign in required", message: "No such workspace or notice.", back: "/", requestId, authed: !!resolved.session }));
      return true;
    }
    try {
      const viewed = await markNoticeRead(pool, resolved.claim, resolved.claim.userId, noticeId);
      if (!viewed) {
        html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such notice.", back: `/w/${workspaceId}/notices`, requestId, authed: true }));
        return true;
      }
      res.writeHead(303, { Location: `/w/${workspaceId}/notices` });
      res.end();
    } catch (err) {
      if (err instanceof TenantDenied) {
        html(res, 404, errorPage({ status: 404, heading: "Not found", message: "No such notice.", back: `/w/${workspaceId}/notices`, requestId, authed: true }));
        return true;
      }
      throw err;
    }
    return true;
  }

  return false;
}

async function noticeLinkDead(
  pool: Pool,
  claims: { userId: string; workspaceId: string },
  notice: NoticeView,
): Promise<boolean> {
  // Foreign/deleted references render as inert notices (no dead link): only
  // import/artifact links can dangle (chat links fall back to the list page,
  // analysis/jobs pages always render). Existence reads stay in-tenant.
  if (!notice.linkHref) return true;
  const importMatch = notice.linkHref.match(/^\/w\/[A-Za-z0-9-]+\/imports\/([A-Za-z0-9-]+)(?:\/|$|\?)/);
  if (importMatch) return !(await targetExists(pool, claims, "imports", importMatch[1]));
  const artifactMatch = notice.linkHref.match(/^\/w\/[A-Za-z0-9-]+\/artifacts\/([A-Za-z0-9-]+)(?:\/|$|\?)/);
  if (artifactMatch) return !(await targetExists(pool, claims, "artifacts", artifactMatch[1]));
  return false;
}

function paletteForm(workspaceId: string, value: string): string {
  return `<form method="get" action="/w/${escapeHtml(workspaceId)}/go"><p><label for="palette-input">Route name</label> <input id="palette-input" name="to" maxlength="80" required autofocus value="${escapeHtml(value)}" list="palette-routes" autocomplete="off"></p><datalist id="palette-routes">${PALETTE_ROUTES.map((r) => `<option value="${escapeHtml(r.name)}">${escapeHtml(r.label)}</option>`).join("")}</datalist><p><button type="submit">Go</button> <button type="reset">Clear</button> <a href="/w/${escapeHtml(workspaceId)}">Back</a></p></form>`;
}

function paletteLinks(workspaceId: string): string {
  return `<h3>All destinations</h3><ul>${PALETTE_ROUTES.map((r) => `<li><a href="${escapeHtml(r.path(workspaceId))}">${escapeHtml(r.label)} (${escapeHtml(r.name)})</a></li>`).join("")}</ul>`;
}

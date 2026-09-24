// E07-S04 durable per-user job notices: PostgreSQL is the truth, the queue
// is only transport (architecture §§204/219-220/324-325). Terminal
// background-job outcomes (and settled artifact versions) produce exactly one
// notice per (workspace, user, source event) via the UNIQUE source event, so
// reload, manual refresh and total Redis event loss converge without
// restarting work and without a realtime service. Notices carry a short safe
// title/body (<=500 visible chars) plus an optional tenant-relative link
// validated at the app layer; failed jobs expose a safe recovery link and an
// allowlisted error class, never a secret or raw payload. withTenant +
// FORCE RLS gate every read/write; foreign rows are simply invisible (the UI
// renders uniform 404 or an inert notice).

import type { Pool, PoolClient } from "pg";
import { isUuid, uuidv7 } from "./ids.ts";
import { TenantDenied, withTenant, type TenantClaims } from "./tenancy.ts";

export const NOTICE_BODY_MAX = 500;
export const NOTICES_PAGE_LIMIT = 50;

export type NoticeKind =
  | "import_completed"
  | "import_failed"
  | "analysis_completed"
  | "analysis_failed"
  | "chat_completed"
  | "chat_failed"
  | "artifact_completed"
  | "artifact_failed";

const KINDS: ReadonlySet<string> = new Set([
  "import_completed",
  "import_failed",
  "analysis_completed",
  "analysis_failed",
  "chat_completed",
  "chat_failed",
  "artifact_completed",
  "artifact_failed",
]);

export function isNoticeKind(value: unknown): value is NoticeKind {
  return typeof value === "string" && KINDS.has(value);
}

export type NoticeView = {
  workspaceId: string;
  userId: string;
  id: string;
  sourceEvent: string;
  kind: NoticeKind;
  title: string;
  body: string;
  linkHref: string | null;
  readAt: string | null;
  createdAt: string;
};

export class NoticeError extends Error {
  readonly code: "not_found" | "invalid_input";
  constructor(code: NoticeError["code"]) {
    super(code);
    this.code = code;
  }
}

const ERROR_CLASS_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** Allowlisted error class for failure notices; raw payloads never render. */
export function safeErrorClass(raw: unknown): string {
  if (typeof raw === "string" && ERROR_CLASS_RE.test(raw)) return raw;
  return "unknown_error";
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function rowToView(row: {
  workspace_id: string;
  user_id: string;
  id: string;
  source_event: string;
  kind: string;
  title: string;
  body: string;
  link_href: string | null;
  read_at: unknown;
  created_at: unknown;
}): NoticeView {
  if (!isNoticeKind(row.kind)) throw new Error("notice kind out of range");
  return {
    workspaceId: row.workspace_id,
    userId: row.user_id,
    id: row.id,
    sourceEvent: row.source_event,
    kind: row.kind,
    title: row.title,
    body: row.body.slice(0, NOTICE_BODY_MAX),
    linkHref: row.link_href,
    readAt: iso(row.read_at),
    createdAt: iso(row.created_at) ?? String(row.created_at),
  };
}

/**
 * Tenant-relative link guard: only exact workspace-scoped paths may back a
 * notice link. Absolute URLs, protocol-relative URLs, backslashes, control
 * characters and cross-workspace paths are rejected (null = inert notice).
 */
export function safeLinkHref(workspaceId: string, raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 500) return null;
  if (!raw.startsWith(`/w/${workspaceId}/`)) return null;
  if (raw.includes("\\") || raw.includes("//") || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  if (raw.includes("?") && /[\s<>"]/.test(raw)) return null;
  if (/[\s<>"]/.test(raw.split("?")[0])) return null;
  return raw;
}

export type NoticeDraft = {
  sourceEvent: string;
  kind: NoticeKind;
  title: string;
  body: string;
  linkHref: string | null;
};

function checkDraft(workspaceId: string, draft: NoticeDraft): NoticeDraft {
  if (typeof draft.sourceEvent !== "string" || draft.sourceEvent.length < 1 || draft.sourceEvent.length > 200) {
    throw new NoticeError("invalid_input");
  }
  if (!isNoticeKind(draft.kind)) throw new NoticeError("invalid_input");
  if (typeof draft.title !== "string" || draft.title.length < 1 || draft.title.length > 200) throw new NoticeError("invalid_input");
  if (typeof draft.body !== "string" || draft.body.length < 1 || draft.body.length > NOTICE_BODY_MAX) throw new NoticeError("invalid_input");
  const linkHref = draft.linkHref === null ? null : safeLinkHref(workspaceId, draft.linkHref);
  return { ...draft, title: draft.title, body: draft.body, linkHref };
}

/**
 * Idempotent terminal-event producer. Runs inside the caller's tenant
 * transaction (the outbox-terminal path or the missed-event sync): the
 * UNIQUE (workspace, user, source event) fence absorbs replays, so exactly
 * one notice exists per terminal outcome. Returns true when inserted.
 */
export async function insertTerminalNoticeTx(
  client: PoolClient,
  workspaceId: string,
  userId: string,
  draft: NoticeDraft,
): Promise<boolean> {
  if (!isUuid(workspaceId) || !isUuid(userId)) throw new TenantDenied();
  const clean = checkDraft(workspaceId, draft);
  const done = await client.query(
    "INSERT INTO notices (workspace_id, user_id, id, source_event, kind, title, body, link_href) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (workspace_id, user_id, source_event) DO NOTHING",
    [workspaceId, userId, uuidv7(), clean.sourceEvent, clean.kind, clean.title, clean.body, clean.linkHref],
  );
  return (done.rowCount ?? 0) === 1;
}

type TerminalJob = {
  id: string;
  job_type: string;
  status: string;
  error_code: string | null;
  input_ref: { importId?: string; threadId?: string; runId?: string } | null;
  result_ref: { importId?: string; total?: number; staged?: number; matched?: number; review?: number; rejected?: number } | null;
  completed_at: unknown;
};

type SettledVersion = {
  id: string;
  artifact_id: string;
  status: string;
  error_class: string | null;
};

function draftForJob(workspaceId: string, job: TerminalJob): NoticeDraft | null {
  const input = job.input_ref ?? {};
  const linkFor = (href: string): string | null => safeLinkHref(workspaceId, href);
  if (job.status === "SUCCEEDED") {
    if (job.job_type === "imports.parse" && typeof input.importId === "string" && isUuid(input.importId)) {
      return {
        sourceEvent: `background_job:${job.id}:SUCCEEDED`,
        kind: "import_completed",
        title: "Import parsed",
        body: "The bank file finished parsing. Open the import to map columns and commit rows.",
        linkHref: linkFor(`/w/${workspaceId}/imports/${input.importId}`),
      };
    }
    if (job.job_type === "imports.commit") {
      const counts = job.result_ref;
      const importId = counts?.importId ?? input.importId;
      const summary =
        counts && typeof counts.total === "number"
          ? `${counts.total} rows: ${counts.staged ?? 0} new, ${counts.matched ?? 0} matched, ${counts.review ?? 0} need review.`
          : "Rows were committed. Open the import for the final counts.";
      if (typeof importId !== "string" || !isUuid(importId)) return null;
      return {
        sourceEvent: `background_job:${job.id}:SUCCEEDED`,
        kind: "import_completed",
        title: "Import committed",
        body: summary.slice(0, NOTICE_BODY_MAX),
        linkHref: linkFor(`/w/${workspaceId}/imports/${importId}`),
      };
    }
    if (job.job_type === "imports.start") {
      return {
        sourceEvent: `background_job:${job.id}:SUCCEEDED`,
        kind: "import_completed",
        title: "Import job finished",
        body: "The background import job finished. Open Jobs for details.",
        linkHref: linkFor(`/w/${workspaceId}/jobs/${job.id}`),
      };
    }
    if (job.job_type === "deep-analysis.run") {
      return {
        sourceEvent: `background_job:${job.id}:SUCCEEDED`,
        kind: "analysis_completed",
        title: "Deep Analysis ready",
        body: "The initial Deep Analysis published its saved report and validated findings.",
        linkHref: linkFor(`/w/${workspaceId}/analysis`),
      };
    }
    if (job.job_type === "chat.generate" && typeof input.threadId === "string" && isUuid(input.threadId)) {
      return {
        sourceEvent: `background_job:${job.id}:SUCCEEDED`,
        kind: "chat_completed",
        title: "Assistant reply ready",
        body: "The assistant finished its reply. Open the conversation to read it with evidence.",
        linkHref: linkFor(`/w/${workspaceId}/chat/${input.threadId}`),
      };
    }
    return null;
  }
  if (job.status === "FAILED_FINAL") {
    const errorClass = safeErrorClass(job.error_code);
    if (job.job_type === "imports.parse" || job.job_type === "imports.commit" || job.job_type === "imports.start") {
      const importId = job.result_ref?.importId ?? input.importId;
      const link =
        typeof importId === "string" && isUuid(importId)
          ? linkFor(`/w/${workspaceId}/imports/${importId}`)
          : linkFor(`/w/${workspaceId}/imports/new`);
      return {
        sourceEvent: `background_job:${job.id}:FAILED_FINAL`,
        kind: "import_failed",
        title: "Import failed",
        body: `The import job failed (${errorClass}). Nothing partial was committed. Open the import or start a fresh upload.`,
        linkHref: link,
      };
    }
    if (job.job_type === "deep-analysis.run") {
      return {
        sourceEvent: `background_job:${job.id}:FAILED_FINAL`,
        kind: "analysis_failed",
        title: "Deep Analysis failed",
        body: `The analysis run failed (${errorClass}) without publishing a report. Open Deep Analysis to retry.`,
        linkHref: linkFor(`/w/${workspaceId}/analysis`),
      };
    }
    if (job.job_type === "chat.generate") {
      const threadId = input.threadId;
      const link =
        typeof threadId === "string" && isUuid(threadId)
          ? linkFor(`/w/${workspaceId}/chat/${threadId}`)
          : linkFor(`/w/${workspaceId}/chat`);
      return {
        sourceEvent: `background_job:${job.id}:FAILED_FINAL`,
        kind: "chat_failed",
        title: "Assistant reply failed",
        body: `The assistant run failed (${errorClass}). Open the conversation to retry the turn.`,
        linkHref: link,
      };
    }
    return null;
  }
  return null;
}

function draftForVersion(workspaceId: string, version: SettledVersion): NoticeDraft | null {
  if (version.status === "ready") {
    return {
      sourceEvent: `artifact_version:${version.id}:ready`,
      kind: "artifact_completed",
      title: "Artifact build ready",
      body: "The artifact version finished building. Open it to preview the current data.",
      linkHref: safeLinkHref(workspaceId, `/w/${workspaceId}/artifacts/${version.artifact_id}?tab=preview`),
    };
  }
  if (version.status === "failed") {
    return {
      sourceEvent: `artifact_version:${version.id}:failed`,
      kind: "artifact_failed",
      title: "Artifact build failed",
      body: `The artifact build failed (${safeErrorClass(version.error_class)}). The previous ready version is kept. Open Versions to retry.`,
      linkHref: safeLinkHref(workspaceId, `/w/${workspaceId}/artifacts/${version.artifact_id}?tab=versions`),
    };
  }
  return null;
}

/**
 * Missed-event recovery over PostgreSQL truth (architecture §220: on missed
 * event/disconnect the client refetches job state). Reads recent terminal
 * background_jobs plus settled artifact versions and inserts the missing
 * notices idempotently. Pure derivation: never enqueues, never restarts work,
 * never mutates jobs. Safe to run on every jobs/notices page load.
 */
export async function syncNoticesForTerminalJobs(pool: Pool, claims: TenantClaims, userId: string): Promise<{ created: number }> {
  if (!isUuid(userId)) throw new TenantDenied();
  return withTenant(pool, claims, async (client) => {
    let created = 0;
    const jobs = await client.query(
      "SELECT id, job_type, status, error_code, input_ref AS \"inputRef\", result_ref AS \"resultRef\", completed_at FROM background_jobs WHERE workspace_id = $1 AND status IN ('SUCCEEDED', 'FAILED_FINAL') ORDER BY completed_at DESC NULLS LAST, created_at DESC LIMIT 200",
      [claims.workspaceId],
    );
    for (const row of jobs.rows as (Omit<TerminalJob, "input_ref" | "result_ref" | "completed_at"> & { inputRef: TerminalJob["input_ref"]; resultRef: TerminalJob["result_ref"] })[]) {
      const job: TerminalJob = {
        id: row.id,
        job_type: row.job_type,
        status: row.status,
        error_code: row.error_code,
        input_ref: (row.inputRef ?? null) as TerminalJob["input_ref"],
        result_ref: (row.resultRef ?? null) as TerminalJob["result_ref"],
        completed_at: null,
      };
      if (!isUuid(job.id)) continue;
      const draft = draftForJob(claims.workspaceId, job);
      if (!draft) continue;
      if (await insertTerminalNoticeTx(client, claims.workspaceId, userId, draft)) created += 1;
    }
    const versions = await client.query(
      "SELECT id, artifact_id, status, error_class FROM artifact_versions WHERE workspace_id = $1 AND status IN ('ready', 'failed') ORDER BY created_at DESC LIMIT 200",
      [claims.workspaceId],
    );
    for (const row of versions.rows as { id: string; artifact_id: string; status: string; error_class: string | null }[]) {
      if (!isUuid(row.id) || !isUuid(row.artifact_id)) continue;
      const draft = draftForVersion(claims.workspaceId, { id: row.id, artifact_id: row.artifact_id, status: row.status, error_class: row.error_class });
      if (!draft) continue;
      if (await insertTerminalNoticeTx(client, claims.workspaceId, userId, draft)) created += 1;
    }
    return { created };
  });
}

export async function listNotices(
  pool: Pool,
  claims: TenantClaims,
  userId: string,
  opts?: { limit?: number; offset?: number },
): Promise<{ notices: NoticeView[]; total: number; unread: number }> {
  if (!isUuid(userId)) throw new TenantDenied();
  const limit = opts?.limit === undefined ? NOTICES_PAGE_LIMIT : opts.limit;
  const offset = opts?.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > NOTICES_PAGE_LIMIT) throw new NoticeError("invalid_input");
  if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) throw new NoticeError("invalid_input");
  return withTenant(pool, claims, async (client) => {
    const total = await client.query("SELECT count(*)::int AS n FROM notices WHERE workspace_id = $1 AND user_id = $2", [claims.workspaceId, userId]);
    const unread = await client.query("SELECT count(*)::int AS n FROM notices WHERE workspace_id = $1 AND user_id = $2 AND read_at IS NULL", [
      claims.workspaceId,
      userId,
    ]);
    const rows = await client.query(
      "SELECT workspace_id, user_id, id, source_event, kind, title, body, link_href, read_at, created_at FROM notices WHERE workspace_id = $1 AND user_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4",
      [claims.workspaceId, userId, limit, offset],
    );
    return {
      notices: (rows.rows as Parameters<typeof rowToView>[0][]).map(rowToView),
      total: (total.rows[0] as { n: number }).n,
      unread: (unread.rows[0] as { n: number }).n,
    };
  });
}

export async function markNoticeRead(pool: Pool, claims: TenantClaims, userId: string, noticeId: string): Promise<NoticeView | null> {
  if (!isUuid(userId) || !isUuid(noticeId)) return null;
  return withTenant(pool, claims, async (client) => {
    const updated = await client.query(
      "UPDATE notices SET read_at = coalesce(read_at, now()) WHERE workspace_id = $1 AND user_id = $2 AND id = $3 RETURNING workspace_id, user_id, id, source_event, kind, title, body, link_href, read_at, created_at",
      [claims.workspaceId, userId, noticeId],
    );
    if ((updated.rowCount ?? 0) === 0) return null;
    return rowToView(updated.rows[0] as Parameters<typeof rowToView>[0]);
  });
}

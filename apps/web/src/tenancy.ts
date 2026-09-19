// E01-S03 tenant ownership: session → membership → transaction-local RLS
// context. withTenant is the ONLY path that sets tenant context: one pooled
// client, BEGIN, set_config LOCAL for both settings, membership check, work,
// then COMMIT/ROLLBACK. SET LOCAL cannot leak across checkouts (it dies with
// the transaction), and every query additionally scopes by workspace so RLS
// stays defense in depth rather than the only layer.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";
import { isUuid, uuidv7 } from "./ids.ts";
import type { Session } from "./session-store.ts";
import { CommandError, getAccountView, listAccountViews, renameAccount, validateRenameInput, createAccount as createAccountCmd, validateCreateAccountInput, updateAccount, validateUpdateAccountInput, manualTransaction, validateManualTransactionInput, balanceSnapshot, validateBalanceSnapshotInput, balanceCorrection, validateBalanceCorrectionInput, listManualTransactions, listBalanceSnapshots, getBalanceSnapshot, listBalanceAudit } from "./commands/accounts.ts";
import { acceptImportJob, JobError, readJob, validateAcceptInput } from "./jobs.ts";
import { cancelJob } from "./job-recovery.ts";
import { bumpCalculationVersion, bumpWorkspaceRevision, getCalculationVersion, getWorkspaceRevision, validateBumpCalculationVersionInput, validateBumpWorkspaceRevisionInput, bumpCalculationVersionInputSchema, bumpWorkspaceRevisionInputSchema, BUMP_CALCULATION_VERSION_COMMAND, BUMP_WORKSPACE_REVISION_COMMAND } from "./calculations/evidence.ts";
import { acceptUpload, listObservations, loadUploadConfig, MAX_UPLOAD_BYTES, readImport, UploadError } from "./uploads.ts";
import { acceptImportCommitJob, ImportCommitError, readImportCommitStatus } from "./import-commit.ts";
import { acceptMapping, listMappingProfiles, MappingError, mappingErrorBody, proposeMapping, readCurrentMapping } from "./mapping.ts";
import { liveMappingTransport, loadMappingProvider } from "./mapping-provider.ts";
import { readMultipart } from "./multipart.ts";
import { consumePermit, getPolicy, issuePermit, PolicyError, setAccountExclusion, summarizeEligible } from "./ai-policy.ts";
import {
  cancelTurn,
  chatErrorBody,
  ChatError,
  createThread,
  getThread,
  listThreads,
  readActivity,
  retryTurn,
  sendTurn,
} from "./chat.ts";
import { readLimitedBody } from "./http-controls.ts";
import { createFakeProvider } from "./ai-fake-provider.ts";
import {
  TxError,
  addTag as addTagCmd,
  archiveCategory as archiveCategoryCmd,
  archiveTag as archiveTagCmd,
  bulkSetCategory as bulkSetCategoryCmd,
  correct as correctCmd,
  createCategory as createCategoryCmd,
  createTag as createTagCmd,
  getTransaction,
  listAudit,
  listCategories,
  listSystemCategories,
  listTags,
  removeTag as removeTagCmd,
  setCategory as setCategoryCmd,
  undo as undoCmd,
  validateArchiveCategoryInput,
  validateArchiveTagInput,
  validateBulkSetCategoryInput,
  validateCorrectInput,
  validateCreateCategoryInput,
  validateCreateTagInput,
  validateSetCategoryInput,
  validateTagLinkInput,
  validateUndoInput,
} from "./commands/transactions.ts";
import { getTransactionEvidence, listTransactions } from "./transactions-query.ts";
import { getFinancialSummary } from "./calculations/financial-summary.ts";
import {
  confirm as confirmRecurringCmd,
  dismiss as dismissRecurringCmd,
  listRecurring,
  validateConfirmInput as validateRecurringConfirmInput,
  validateDismissInput as validateRecurringDismissInput,
} from "./commands/recurring.ts";
import {
  createArtifactDraft,
  submitArtifactBuild,
  getArtifactVersion,
  listArtifactVersions,
  activateArtifactVersion,
  getArtifact,
  listArtifacts,
} from "./commands/artifacts.ts";

export class TenantDenied extends Error {
  constructor() {
    super("tenant_denied");
  }
}

/** Malformed caller input (distinct from denial: reveals nothing about tenants). */
export class TenantInvalid extends Error {
  constructor() {
    super("tenant_invalid");
  }
}

export type TenantClaims = { userId: string; workspaceId: string };

/** Run work as a verified member of the workspace. Throws TenantDenied for non-members. */
export async function withTenant<T>(pool: Pool, claims: TenantClaims, work: (client: PoolClient) => Promise<T>, isolation?: "REPEATABLE READ"): Promise<T> {
  if (!isUuid(claims.userId) || !isUuid(claims.workspaceId)) throw new TenantDenied();
  const client = await pool.connect();
  try {
    await client.query(isolation ? `BEGIN ISOLATION LEVEL ${isolation}` : "BEGIN");
    await client.query("SELECT set_config('app.current_user', $1, true), set_config('app.current_workspace', $2, true)", [
      claims.userId,
      claims.workspaceId,
    ]);
    const member = await client.query("SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [
      claims.workspaceId,
      claims.userId,
    ]);
    if ((member.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      throw new TenantDenied();
    }
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch { /* preserve the original error */ }
    throw err;
  } finally {
    client.release();
  }
}

export type Workspace = { id: string; name: string; baseCurrency: string; timezone: string; role: string };

function checkName(name: unknown): string {
  if (typeof name !== "string" || name.length < 1 || name.length > 200) throw new TenantInvalid();
  return name;
}

function checkCurrency(code: unknown): string {
  if (typeof code !== "string" || !/^[A-Z]{3}$/.test(code)) throw new TenantInvalid();
  return code;
}

/** Run work as a user without claiming a workspace (listing only). */
export async function withUser<T>(pool: Pool, userId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!isUuid(userId)) throw new TenantDenied();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_user', $1, true)", [userId]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch { /* preserve the original error */ }
    throw err;
  } finally {
    client.release();
  }
}

export async function createWorkspace(pool: Pool, authSubject: string, input: { name: string; baseCurrency: string; timezone?: string }): Promise<Workspace> {
  const name = checkName(input.name);
  const baseCurrency = checkCurrency(input.baseCurrency);
  const timezone = typeof input.timezone === "string" && input.timezone.length >= 1 && input.timezone.length <= 64 ? input.timezone : "UTC";
  const workspaceId = uuidv7();
  const userId = uuidv7();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_user', $1, true), set_config('app.current_workspace', $2, true)", [userId, workspaceId]);
    // users carries no RLS (identity anchor); claim-or-create by verified sub.
    const existing = await client.query("SELECT id FROM users WHERE auth_subject = $1", [authSubject]);
    const ownerId = (existing.rowCount ?? 0) > 0 ? (existing.rows[0] as { id: string }).id : userId;
    if ((existing.rowCount ?? 0) === 0) {
      await client.query("INSERT INTO users (id, auth_subject) VALUES ($1, $2)", [userId, authSubject]);
    } else {
      await client.query("SELECT set_config('app.current_user', $1, true)", [ownerId]);
    }
    await client.query("INSERT INTO workspaces (id, name, base_currency_code, timezone) VALUES ($1, $2, $3, $4)", [workspaceId, name, baseCurrency, timezone]);
    await client.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [workspaceId, ownerId]);
    await client.query("COMMIT");
    return { id: workspaceId, name, baseCurrency, timezone, role: "owner" };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch { /* preserve the original error */ }
    throw err;
  } finally {
    client.release();
  }
}

export async function listWorkspaces(pool: Pool, authSubject: string): Promise<Workspace[]> {
  const idRows = await pool.query("SELECT id FROM users WHERE auth_subject = $1", [authSubject]);
  if ((idRows.rowCount ?? 0) === 0) return [];
  const userId = (idRows.rows[0] as { id: string }).id;
  // User context only: the membership read policies admit exactly this
  // user's workspaces, and nothing else. No workspace is claimed.
  return withUser(pool, userId, async (client) => {
    const rows = await client.query(
      "SELECT w.id, w.name, w.base_currency_code AS \"baseCurrency\", w.timezone, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id WHERE m.user_id = $1 ORDER BY w.created_at",
      [userId],
    );
    return rows.rows as Workspace[];
  });
}

export type Account = { workspaceId: string; id: string; name: string; version: string };

export async function createAccount(pool: Pool, claims: TenantClaims, name: string): Promise<Account> {
  const clean = checkName(name);
  return withTenant(pool, claims, async (client) => {
    const id = uuidv7();
    const rows = await client.query("INSERT INTO accounts (workspace_id, id, name) VALUES ($1, $2, $3) RETURNING version", [claims.workspaceId, id, clean]);
    const version = String((rows.rows[0] as { version: string }).version);
    return { workspaceId: claims.workspaceId, id, name: clean, version };
  });
}

function commandErrorBody(err: CommandError): { status: number; body: unknown } {
  if (err.code === "not_found") return { status: 404, body: { error: "not_found" } };
  if (err.code === "version_mismatch") {
    return { status: 409, body: err.currentVersion === undefined ? { error: "conflict", reason: err.code } : { error: "conflict", reason: err.code, currentVersion: err.currentVersion } };
  }
  return { status: 409, body: { error: "conflict", reason: err.code } };
}

// ---- HTTP boundary ----

export type SessionResolver = (req: IncomingMessage) => Promise<Session | null>;

function tenantJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  });
  res.end(payload);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return readLimitedBody(req, 64 * 1024).then((body) => {
    try {
      return body.length ? (JSON.parse(body.toString("utf8")) as unknown) : {};
    } catch {
      throw new Error("body_invalid");
    }
  });
}

/** Single session resolution per call: branch on session (401) versus claim (404) without a second roundtrip. Shared with the UI router. */
export async function sessionClaims(
  pool: Pool,
  resolveSession: SessionResolver,
  req: IncomingMessage,
  workspaceId: string,
): Promise<{ session: Session | null; claim: TenantClaims | null }> {
  const session = await resolveSession(req);
  if (!session || !isUuid(workspaceId)) return { session, claim: null };
  const found = await pool.query("SELECT id FROM users WHERE auth_subject = $1", [session.keycloakSub]);
  if ((found.rowCount ?? 0) === 0) return { session, claim: null };
  return { session, claim: { userId: (found.rows[0] as { id: string }).id, workspaceId } };
}

export type TenancyRouter = {
  handle: (req: IncomingMessage, res: ServerResponse, path: string, method: string, query: URLSearchParams, requestId?: string) => Promise<boolean>;
};

// Test-transport log only (dies with the process). Bounded so a long-lived
// dev server cannot grow it without limit; E02/E04 replace this transport.
const fakeTransport = createFakeProvider(200);

function policyErrorBody(err: PolicyError): { status: number; body: unknown } {
  if (err.code === "unknown_account") return { status: 400, body: { error: "invalid_request", reason: err.code } };
  return { status: 409, body: { error: "conflict", reason: err.code } };
}

function jobErrorBody(err: JobError): { status: number; body: unknown } {
  if (err.code === "not_found") return { status: 404, body: { error: "not_found" } };
  if (err.code === "workspace_busy") return { status: 409, body: { error: "conflict", reason: err.code } };
  return { status: 409, body: { error: "conflict", reason: err.code } };
}

function uploadErrorBody(err: UploadError): { status: number; body: unknown } {
  if (err.code === "not_found") return { status: 404, body: { error: "not_found" } };
  if (err.code === "payload_too_large") return { status: 413, body: { error: "payload_too_large", reason: err.reason ?? "upload-limit" } };
  if (err.code === "idempotency_reuse") return { status: 409, body: { error: "conflict", reason: err.code } };
  return { status: 400, body: { error: "invalid_request", ...(err.reason ? { reason: err.reason } : {}) } };
}

function importCommitErrorBody(err: ImportCommitError): { status: number; body: unknown } {
  if (err.code === "not_found") return { status: 404, body: { error: "not_found" } };
  return { status: 409, body: { error: "conflict", reason: err.code } };
}

function txErrorBody(err: TxError): { status: number; body: unknown } {
  if (err.code === "not_found") return { status: 404, body: { error: "not_found" } };
  // unsupported_operation is an honest 400 (wrong kind/shape for this
  // command), never a version or undo conflict; unsupported_undo stays 409
  // strictly for operations.undo on non-undoable operations.
  if (err.code === "unsupported_operation") return { status: 400, body: { error: "invalid_request", reason: err.code } };
  if (err.code === "version_mismatch" || err.code === "undo_conflict") {
    return {
      status: 409,
      body: {
        error: "conflict",
        reason: err.code,
        ...(err.currentVersion === undefined ? {} : { currentVersion: err.currentVersion }),
        ...(err.detail === undefined ? {} : { detail: err.detail }),
      },
    };
  }
  return { status: 409, body: { error: "conflict", reason: err.code } };
}


export function createTenancyRouter(pool: Pool, resolveSession: SessionResolver): TenancyRouter {
  // Every route resolves the session first (uniform 401), then the user row,
  // then membership inside withTenant. Missing and foreign resources share
  // one 404 body so callers cannot distinguish them.
  async function claims(req: IncomingMessage, workspaceId: string): Promise<{ session: Session | null; claim: TenantClaims | null }> {
    return sessionClaims(pool, resolveSession, req, workspaceId);
  }

  function denied(res: ServerResponse, authed: boolean): void {
    // Authenticated-but-denied shares one body with missing resources so
    // callers cannot distinguish foreign from absent; unauthenticated callers
    // get the auth boundary's 401 instead.
    if (authed) tenantJson(res, 404, { error: "not_found" });
    else tenantJson(res, 401, { error: "unauthorized" });
  }

  return {
    handle: async (req, res, path, method, query, requestId = "uncontrolled") => {
      // JSON routes (POST/PUT) read the body via readJsonBody, the sole
      // "data" listener — discarding here first would eat the body and hang
      // the reader waiting for "end" (S03 drain lesson). Everything else
      // discards up front so sockets stay reusable.
      if (method !== "POST" && method !== "PUT") req.resume();
      req.on("error", () => {});
      try {
        if (path === "/api/workspaces" && method === "GET") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          tenantJson(res, 200, { workspaces: await listWorkspaces(pool, session.keycloakSub) });
          return true;
        }
        if (path === "/api/workspaces" && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          const body = (await readJsonBody(req)) as { name?: unknown; baseCurrency?: unknown; timezone?: unknown };
          tenantJson(res, 201, await createWorkspace(pool, session.keycloakSub, { name: body.name as string, baseCurrency: body.baseCurrency as string, timezone: body.timezone as string | undefined }));
          return true;
        }
        if (path === "/api/accounts" && method === "GET") {
          const workspaceId = query.get("workspaceId") ?? "";
          const resolved = await claims(req, workspaceId);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          tenantJson(res, 200, { accounts: await listAccountViews(pool, resolved.claim) });
          return true;
        }
        if (path === "/api/accounts" && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          const body = (await readJsonBody(req)) as { workspaceId?: unknown; name?: unknown };
          if (typeof body.workspaceId !== "string" || !isUuid(body.workspaceId)) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          const resolved = await claims(req, body.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          tenantJson(res, 201, await createAccount(pool, resolved.claim, body.name as string));
          return true;
        }
        if (path === "/api/commands/accounts.rename" && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          // Schema-validated once here; the domain module validates again on
          // the same objects so HTTP can never smuggle unchecked input.
          const input = validateRenameInput(await readJsonBody(req));
          const resolved = await claims(req, input.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            const result = await renameAccount(pool, resolved.claim, resolved.claim.userId, input);
            tenantJson(res, 200, { ...result.view, operationId: result.operationId, replayed: result.replayed });
          } catch (err) {
            if (err instanceof CommandError) {
              const mapped = commandErrorBody(err);
              tenantJson(res, mapped.status, mapped.body);
              return true;
            }
            throw err;
          }
          return true;
        }
        if (path === "/api/commands/accounts.create" && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          const input = validateCreateAccountInput(await readJsonBody(req));
          const resolved = await claims(req, input.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            const result = await createAccountCmd(pool, resolved.claim, resolved.claim.userId, input);
            tenantJson(res, 200, { ...result.view, operationId: result.operationId, replayed: result.replayed });
          } catch (err) {
            if (err instanceof CommandError) {
              const mapped = commandErrorBody(err);
              tenantJson(res, mapped.status, mapped.body);
              return true;
            }
            throw err;
          }
          return true;
        }
        if (path === "/api/commands/accounts.update" && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          const input = validateUpdateAccountInput(await readJsonBody(req));
          const resolved = await claims(req, input.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            const result = await updateAccount(pool, resolved.claim, resolved.claim.userId, input);
            tenantJson(res, 200, { ...result.view, operationId: result.operationId, replayed: result.replayed });
          } catch (err) {
            if (err instanceof CommandError) {
              const mapped = commandErrorBody(err);
              tenantJson(res, mapped.status, mapped.body);
              return true;
            }
            throw err;
          }
          return true;
        }
        if (path === "/api/commands/accounts.manual_transaction" && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          const input = validateManualTransactionInput(await readJsonBody(req));
          const resolved = await claims(req, input.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            const result = await manualTransaction(pool, resolved.claim, resolved.claim.userId, input);
            tenantJson(res, 200, { ...result.view, operationId: result.operationId, replayed: result.replayed });
          } catch (err) {
            if (err instanceof CommandError) {
              const mapped = commandErrorBody(err);
              tenantJson(res, mapped.status, mapped.body);
              return true;
            }
            throw err;
          }
          return true;
        }
        if (path === "/api/commands/accounts.balance_snapshot" && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          const input = validateBalanceSnapshotInput(await readJsonBody(req));
          const resolved = await claims(req, input.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            const result = await balanceSnapshot(pool, resolved.claim, resolved.claim.userId, input);
            tenantJson(res, 200, { ...result.view, operationId: result.operationId, replayed: result.replayed });
          } catch (err) {
            if (err instanceof CommandError) {
              const mapped = commandErrorBody(err);
              tenantJson(res, mapped.status, mapped.body);
              return true;
            }
            throw err;
          }
          return true;
        }
        if (path === "/api/commands/accounts.balance_correction" && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          const input = validateBalanceCorrectionInput(await readJsonBody(req));
          const resolved = await claims(req, input.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            const result = await balanceCorrection(pool, resolved.claim, resolved.claim.userId, input);
            tenantJson(res, 200, { ...result.view, operationId: result.operationId, replayed: result.replayed });
          } catch (err) {
            if (err instanceof CommandError) {
              const mapped = commandErrorBody(err);
              tenantJson(res, mapped.status, mapped.body);
              return true;
            }
            throw err;
          }
          return true;
        }
        // E03-S05 categories/tags/corrections/audit/undo. Every command
        // revalidates session -> membership -> withTenant; foreign and
        // missing ids share the uniform 404 body.
        if (path === "/api/commands/categories.create" && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          let input: ReturnType<typeof validateCreateCategoryInput>;
          try {
            input = validateCreateCategoryInput(await readJsonBody(req));
          } catch {
            tenantJson(res, 400, { error: "invalid_request" });
            return true;
          }
          const resolved = await claims(req, input.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            const result = await createCategoryCmd(pool, resolved.claim, resolved.claim.userId, input);
            tenantJson(res, 200, { ...result.view, operationId: result.operationId, replayed: result.replayed });
          } catch (err) {
            if (err instanceof TxError) {
              const mapped = txErrorBody(err);
              tenantJson(res, mapped.status, mapped.body);
              return true;
            }
            throw err;
          }
          return true;
        }
        if (path === "/api/commands/categories.archive" && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          let input: ReturnType<typeof validateArchiveCategoryInput>;
          try {
            input = validateArchiveCategoryInput(await readJsonBody(req));
          } catch {
            tenantJson(res, 400, { error: "invalid_request" });
            return true;
          }
          const resolved = await claims(req, input.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            const result = await archiveCategoryCmd(pool, resolved.claim, resolved.claim.userId, input);
            tenantJson(res, 200, { ...result.view, operationId: result.operationId, replayed: result.replayed });
          } catch (err) {
            if (err instanceof TxError) {
              const mapped = txErrorBody(err);
              tenantJson(res, mapped.status, mapped.body);
              return true;
            }
            throw err;
          }
          return true;
        }
        if (path === "/api/categories" && method === "GET") {
          const workspaceId = query.get("workspaceId") ?? "";
          const resolved = await claims(req, workspaceId);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          tenantJson(res, 200, { categories: await listCategories(pool, resolved.claim, query.get("includeArchived") === "1"), requestId });
          return true;
        }
        if (path === "/api/system-categories" && method === "GET") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          tenantJson(res, 200, { categories: await listSystemCategories(pool), requestId });
          return true;
        }
        if (path === "/api/commands/tags.create" && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          let input: ReturnType<typeof validateCreateTagInput>;
          try {
            input = validateCreateTagInput(await readJsonBody(req));
          } catch {
            tenantJson(res, 400, { error: "invalid_request" });
            return true;
          }
          const resolved = await claims(req, input.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            const result = await createTagCmd(pool, resolved.claim, resolved.claim.userId, input);
            tenantJson(res, 200, { ...result.view, operationId: result.operationId, replayed: result.replayed });
          } catch (err) {
            if (err instanceof TxError) {
              const mapped = txErrorBody(err);
              tenantJson(res, mapped.status, mapped.body);
              return true;
            }
            throw err;
          }
          return true;
        }
        if (path === "/api/commands/tags.archive" && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          let input: ReturnType<typeof validateArchiveTagInput>;
          try {
            input = validateArchiveTagInput(await readJsonBody(req));
          } catch {
            tenantJson(res, 400, { error: "invalid_request" });
            return true;
          }
          const resolved = await claims(req, input.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            const result = await archiveTagCmd(pool, resolved.claim, resolved.claim.userId, input);
            tenantJson(res, 200, { ...result.view, operationId: result.operationId, replayed: result.replayed });
          } catch (err) {
            if (err instanceof TxError) {
              const mapped = txErrorBody(err);
              tenantJson(res, mapped.status, mapped.body);
              return true;
            }
            throw err;
          }
          return true;
        }
        if (path === "/api/tags" && method === "GET") {
          const workspaceId = query.get("workspaceId") ?? "";
          const resolved = await claims(req, workspaceId);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          tenantJson(res, 200, { tags: await listTags(pool, resolved.claim, query.get("includeArchived") === "1"), requestId });
          return true;
        }
        if (path === "/api/commands/transactions.set_category" && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          let input: ReturnType<typeof validateSetCategoryInput>;
          try {
            input = validateSetCategoryInput(await readJsonBody(req));
          } catch {
            tenantJson(res, 400, { error: "invalid_request" });
            return true;
          }
          const resolved = await claims(req, input.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            const result = await setCategoryCmd(pool, resolved.claim, resolved.claim.userId, input);
            tenantJson(res, 200, { ...result.view, operationId: result.operationId, replayed: result.replayed });
          } catch (err) {
            if (err instanceof TxError) {
              const mapped = txErrorBody(err);
              tenantJson(res, mapped.status, mapped.body);
              return true;
            }
            throw err;
          }
          return true;
        }
        if (path === "/api/commands/transactions.add_tag" && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          let input: ReturnType<typeof validateTagLinkInput>;
          try {
            input = validateTagLinkInput(await readJsonBody(req));
          } catch {
            tenantJson(res, 400, { error: "invalid_request" });
            return true;
          }
          const resolved = await claims(req, input.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            const result = await addTagCmd(pool, resolved.claim, resolved.claim.userId, input);
            tenantJson(res, 200, { ...result.view, operationId: result.operationId, replayed: result.replayed });
          } catch (err) {
            if (err instanceof TxError) {
              const mapped = txErrorBody(err);
              tenantJson(res, mapped.status, mapped.body);
              return true;
            }
            throw err;
          }
          return true;
        }
        if (path === "/api/commands/transactions.remove_tag" && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          let input: ReturnType<typeof validateTagLinkInput>;
          try {
            input = validateTagLinkInput(await readJsonBody(req));
          } catch {
            tenantJson(res, 400, { error: "invalid_request" });
            return true;
          }
          const resolved = await claims(req, input.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            const result = await removeTagCmd(pool, resolved.claim, resolved.claim.userId, input);
            tenantJson(res, 200, { ...result.view, operationId: result.operationId, replayed: result.replayed });
          } catch (err) {
            if (err instanceof TxError) {
              const mapped = txErrorBody(err);
              tenantJson(res, mapped.status, mapped.body);
              return true;
            }
            throw err;
          }
          return true;
        }
        if (path === "/api/commands/transactions.correct" && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          let input: ReturnType<typeof validateCorrectInput>;
          try {
            input = validateCorrectInput(await readJsonBody(req));
          } catch {
            tenantJson(res, 400, { error: "invalid_request" });
            return true;
          }
          const resolved = await claims(req, input.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            const result = await correctCmd(pool, resolved.claim, resolved.claim.userId, input);
            tenantJson(res, 200, { ...result.view, operationId: result.operationId, replayed: result.replayed });
          } catch (err) {
            if (err instanceof TxError) {
              const mapped = txErrorBody(err);
              tenantJson(res, mapped.status, mapped.body);
              return true;
            }
            throw err;
          }
          return true;
        }
        if (path === "/api/commands/operations.undo" && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          let input: ReturnType<typeof validateUndoInput>;
          try {
            input = validateUndoInput(await readJsonBody(req));
          } catch {
            tenantJson(res, 400, { error: "invalid_request" });
            return true;
          }
          const resolved = await claims(req, input.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            const result = await undoCmd(pool, resolved.claim, resolved.claim.userId, input);
            tenantJson(res, 200, { ...result.view, operationId: result.operationId, replayed: result.replayed });
          } catch (err) {
            if (err instanceof TxError) {
              const mapped = txErrorBody(err);
              tenantJson(res, mapped.status, mapped.body);
              return true;
            }
            throw err;
          }
          return true;
        }
        const txGetMatch = path.match(/^\/api\/transactions\/([A-Za-z0-9-]+)$/);
        if (txGetMatch && method === "GET") {
          const workspaceId = query.get("workspaceId") ?? "";
          const kind = query.get("kind") === "manual" ? "manual" : "imported";
          const resolved = await claims(req, workspaceId);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          const view = await getTransaction(pool, resolved.claim, kind, txGetMatch[1]);
          if (!view) tenantJson(res, 404, { error: "not_found" });
          else tenantJson(res, 200, view);
          return true;
        }
        // E03-S06 shared transaction list: filters/sort/page + totals from
        // the same predicates (transactions-query.ts is the single source;
        // the UI below consumes these same functions, never its own SQL).
        if (path === "/api/transactions" && method === "GET") {
          const workspaceId = query.get("workspaceId") ?? "";
          const resolved = await claims(req, workspaceId);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          try {
            const result = await listTransactions(pool, resolved.claim, {
              workspaceId,
              kind: query.get("kind") ?? "all",
              ...(query.get("accountId") ? { accountId: query.get("accountId")! } : {}),
              ...(query.get("categoryId") ? { categoryId: query.get("categoryId")! } : {}),
              ...(query.get("uncategorized") ? { uncategorized: query.get("uncategorized")! } : {}),
              ...(query.get("tagId") ? { tagId: query.get("tagId")! } : {}),
              ...(query.get("direction") ? { direction: query.get("direction")! } : {}),
              ...(query.get("dateFrom") ? { dateFrom: query.get("dateFrom")! } : {}),
              ...(query.get("dateTo") ? { dateTo: query.get("dateTo")! } : {}),
              ...(query.get("search") ? { search: query.get("search")! } : {}),
              ...(query.get("sort") ? { sort: query.get("sort")! } : {}),
              ...(query.get("limit") ? { limit: query.get("limit")! } : {}),
              ...(query.get("offset") ? { offset: query.get("offset")! } : {}),
            });
            tenantJson(res, 200, { ...result, requestId });
          } catch (err) {
            if (err instanceof TenantInvalid) {
              tenantJson(res, 400, { error: "invalid_request" });
              return true;
            }
            throw err;
          }
          return true;
        }
        const txEvidenceMatch = path.match(/^\/api\/transactions\/([A-Za-z0-9-]+)\/evidence$/);
        if (txEvidenceMatch && method === "GET") {
          const workspaceId = query.get("workspaceId") ?? "";
          const kind = query.get("kind") === "manual" ? "manual" : "imported";
          const resolved = await claims(req, workspaceId);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          const evidence = await getTransactionEvidence(pool, resolved.claim, kind, txEvidenceMatch[1]);
          if (!evidence) tenantJson(res, 404, { error: "not_found" });
          else tenantJson(res, 200, { ...evidence, requestId });
          return true;
        }
        if (path === "/api/commands/transactions.bulk_set_category" && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          let input: ReturnType<typeof validateBulkSetCategoryInput>;
          try {
            input = validateBulkSetCategoryInput(await readJsonBody(req));
          } catch {
            tenantJson(res, 400, { error: "invalid_request" });
            return true;
          }
          const resolved = await claims(req, input.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            const result = await bulkSetCategoryCmd(pool, resolved.claim, resolved.claim.userId, input);
            tenantJson(res, 200, { ...result.view, operationId: result.operationId, replayed: result.replayed });
          } catch (err) {
            if (err instanceof TxError) {
              const mapped = txErrorBody(err);
              tenantJson(res, mapped.status, mapped.body);
              return true;
            }
            throw err;
          }
          return true;
        }
        // E03-S07 recurring candidates (pure detection + versioned overrides).
        if (path === "/api/recurring" && method === "GET") {
          const workspaceId = query.get("workspaceId") ?? "";
          const resolved = await claims(req, workspaceId);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          tenantJson(res, 200, { ...(await listRecurring(pool, resolved.claim)), requestId });
          return true;
        }
        if (path === "/api/commands/recurring.confirm" && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          let input: ReturnType<typeof validateRecurringConfirmInput>;
          try {
            input = validateRecurringConfirmInput(await readJsonBody(req));
          } catch {
            tenantJson(res, 400, { error: "invalid_request" });
            return true;
          }
          const resolved = await claims(req, input.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            const result = await confirmRecurringCmd(pool, resolved.claim, resolved.claim.userId, input);
            tenantJson(res, 200, { ...result.view, operationId: result.operationId, replayed: result.replayed });
          } catch (err) {
            if (err instanceof TxError) {
              const mapped = txErrorBody(err);
              tenantJson(res, mapped.status, mapped.body);
              return true;
            }
            throw err;
          }
          return true;
        }
        if (path === "/api/commands/recurring.dismiss" && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          let input: ReturnType<typeof validateRecurringDismissInput>;
          try {
            input = validateRecurringDismissInput(await readJsonBody(req));
          } catch {
            tenantJson(res, 400, { error: "invalid_request" });
            return true;
          }
          const resolved = await claims(req, input.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            const result = await dismissRecurringCmd(pool, resolved.claim, resolved.claim.userId, input);
            tenantJson(res, 200, { ...result.view, operationId: result.operationId, replayed: result.replayed });
          } catch (err) {
            if (err instanceof TxError) {
              const mapped = txErrorBody(err);
              tenantJson(res, mapped.status, mapped.body);
              return true;
            }
            throw err;
          }
          return true;
        }
        const auditMatch = path.match(/^\/api\/audit\/([A-Za-z0-9-]+)$/);
        if (auditMatch && method === "GET") {
          const workspaceId = query.get("workspaceId") ?? "";
          const entityType = query.get("entityType") ?? "transaction";
          const resolved = await claims(req, workspaceId);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          tenantJson(res, 200, { audit: await listAudit(pool, resolved.claim, entityType, auditMatch[1]), requestId });
          return true;
        }
        // E03-S04 calculation evidence: bump calculation version
        if (path === "/api/commands/calculations.bump_version" && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          const input = validateBumpCalculationVersionInput(await readJsonBody(req));
          const resolved = await claims(req, input.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            const result = await bumpCalculationVersion(pool, resolved.claim, resolved.claim.userId, input);
            tenantJson(res, 200, { ...result.view, operationId: result.operationId, replayed: result.replayed });
          } catch (err) {
            if (err instanceof CommandError) {
              const mapped = commandErrorBody(err);
              tenantJson(res, mapped.status, mapped.body);
              return true;
            }
            throw err;
          }
          return true;
        }
        // E03-S04 calculation evidence: bump workspace revision
        if (path === "/api/commands/workspace.bump_revision" && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          const input = validateBumpWorkspaceRevisionInput(await readJsonBody(req));
          const resolved = await claims(req, input.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            const result = await bumpWorkspaceRevision(pool, resolved.claim, resolved.claim.userId, input);
            tenantJson(res, 200, { ...result.view, operationId: result.operationId, replayed: result.replayed });
          } catch (err) {
            if (err instanceof CommandError) {
              const mapped = commandErrorBody(err);
              tenantJson(res, mapped.status, mapped.body);
              return true;
            }
            throw err;
          }
          return true;
        }
        if (path === "/api/calculations/financial-summary" && method === "GET") {
          const workspaceId = query.get("workspaceId") ?? "";
          const resolved = await claims(req, workspaceId);
          if (!resolved.claim) { denied(res, resolved.session !== null); return true; }
          tenantJson(res, 200, await getFinancialSummary(pool, resolved.claim, workspaceId, { accountId: query.get("accountId") ?? undefined, dateFrom: query.get("dateFrom") ?? undefined, dateTo: query.get("dateTo") ?? undefined }));
          return true;
        }
        // E03-S04 calculation evidence: get calculation version
        if (path === "/api/calculations/version" && method === "GET") {
          const workspaceId = query.get("workspaceId") ?? "";
          const resolved = await claims(req, workspaceId);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          const version = await getCalculationVersion(pool, resolved.claim);
          if (!version) tenantJson(res, 404, { error: "not_found" });
          else tenantJson(res, 200, version);
          return true;
        }
        // E03-S04 calculation evidence: get workspace revision
        if (path === "/api/workspace/revision" && method === "GET") {
          const workspaceId = query.get("workspaceId") ?? "";
          const resolved = await claims(req, workspaceId);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          const revision = await getWorkspaceRevision(pool, resolved.claim);
          if (!revision) tenantJson(res, 404, { error: "not_found" });
          else tenantJson(res, 200, revision);
          return true;
        }
        // Manual transactions list for an account
        const manualTxMatch = path.match(/^\/api\/accounts\/([A-Za-z0-9-]+)\/manual_transactions$/);
        if (manualTxMatch && method === "GET") {
          const workspaceId = query.get("workspaceId") ?? "";
          const resolved = await claims(req, workspaceId);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          // Check if account exists in workspace
          const accountExists = await withTenant(pool, resolved.claim, async (client) => {
            const r = await client.query("SELECT 1 FROM accounts WHERE workspace_id = $1 AND id = $2", [resolved.claim!.workspaceId, manualTxMatch[1]]);
            return (r.rowCount ?? 0) > 0;
          });
          if (!accountExists) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          const limit = query.get("limit") ? Number(query.get("limit")!) : 100;
          const offset = query.get("offset") ? Number(query.get("offset")!) : 0;
          tenantJson(res, 200, { transactions: await listManualTransactions(pool, resolved.claim, manualTxMatch[1], limit, offset), requestId });
          return true;
        }
        // Balance snapshots list for an account
        const balanceSnapMatch = path.match(/^\/api\/accounts\/([A-Za-z0-9-]+)\/balance_snapshots$/);
        if (balanceSnapMatch && method === "GET") {
          const workspaceId = query.get("workspaceId") ?? "";
          const resolved = await claims(req, workspaceId);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          // Check if account exists in workspace
          const accountExists = await withTenant(pool, resolved.claim, async (client) => {
            const r = await client.query("SELECT 1 FROM accounts WHERE workspace_id = $1 AND id = $2", [resolved.claim!.workspaceId, balanceSnapMatch[1]]);
            return (r.rowCount ?? 0) > 0;
          });
          if (!accountExists) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          const limit = query.get("limit") ? Number(query.get("limit")!) : 100;
          const offset = query.get("offset") ? Number(query.get("offset")!) : 0;
          tenantJson(res, 200, { snapshots: await listBalanceSnapshots(pool, resolved.claim, balanceSnapMatch[1], limit, offset), requestId });
          return true;
        }
        // Get a specific balance snapshot
        const balanceSnapGetMatch = path.match(/^\/api\/balance_snapshots\/([A-Za-z0-9-]+)$/);
        if (balanceSnapGetMatch && method === "GET") {
          const workspaceId = query.get("workspaceId") ?? "";
          const resolved = await claims(req, workspaceId);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          const snapshot = await getBalanceSnapshot(pool, resolved.claim, balanceSnapGetMatch[1]);
          if (!snapshot) tenantJson(res, 404, { error: "not_found" });
          else tenantJson(res, 200, snapshot);
          return true;
        }
        // Balance audit for a snapshot
        const balanceAuditMatch = path.match(/^\/api\/balance_snapshots\/([A-Za-z0-9-]+)\/audit$/);
        if (balanceAuditMatch && method === "GET") {
          const workspaceId = query.get("workspaceId") ?? "";
          const resolved = await claims(req, workspaceId);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          tenantJson(res, 200, { audit: await listBalanceAudit(pool, resolved.claim, balanceAuditMatch[1]), requestId });
          return true;
        }
        if (path === "/api/ai/exclusions" && method === "PUT") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          const body = (await readJsonBody(req)) as { workspaceId?: unknown; accountId?: unknown; excluded?: unknown; reason?: unknown };
          if (typeof body.workspaceId !== "string" || !isUuid(body.workspaceId) || typeof body.accountId !== "string" || typeof body.excluded !== "boolean") {
            tenantJson(res, 400, { error: "invalid_request" });
            return true;
          }
          const resolved = await claims(req, body.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            tenantJson(res, 200, await setAccountExclusion(pool, resolved.claim, resolved.claim.userId, body.accountId, body.excluded, body.reason as string | undefined));
          } catch (err) {
            if (err instanceof PolicyError) {
              const mapped = policyErrorBody(err);
              tenantJson(res, mapped.status, mapped.body);
              return true;
            }
            throw err;
          }
          return true;
        }
        if (path === "/api/ai/policy" && method === "GET") {
          const workspaceId = query.get("workspaceId") ?? "";
          const resolved = await claims(req, workspaceId);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          tenantJson(res, 200, await getPolicy(pool, resolved.claim));
          return true;
        }
        if (path === "/api/ai/policy/summary" && method === "GET") {
          const workspaceId = query.get("workspaceId") ?? "";
          const resolved = await claims(req, workspaceId);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          tenantJson(res, 200, await summarizeEligible(pool, resolved.claim));
          return true;
        }
        if (path === "/api/ai/permits" && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          const body = (await readJsonBody(req)) as { workspaceId?: unknown; purpose?: unknown; accountIds?: unknown };
          if (typeof body.workspaceId !== "string" || !isUuid(body.workspaceId)) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          if (body.accountIds !== undefined && (!Array.isArray(body.accountIds) || body.accountIds.some((id) => typeof id !== "string"))) {
            tenantJson(res, 400, { error: "invalid_request" });
            return true;
          }
          const resolved = await claims(req, body.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            tenantJson(res, 201, await issuePermit(pool, resolved.claim, body.purpose as string, body.accountIds as string[] | undefined));
          } catch (err) {
            if (err instanceof PolicyError) {
              const mapped = policyErrorBody(err);
              tenantJson(res, mapped.status, mapped.body);
              return true;
            }
            throw err;
          }
          return true;
        }
        if (path === "/api/ai/test-dispatch" && method === "POST") {
          // Test transport only: the recording fake provider E02/E04 replace
          // with the qualified OpenRouter path. Allowlisted to local
          // development/test (including unset); every other environment,
          // production included, gets a uniform 404.
          const appEnv = process.env["APP_ENV"];
          if (appEnv !== undefined && appEnv !== "development" && appEnv !== "test") {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          const body = (await readJsonBody(req)) as { workspaceId?: unknown; permitId?: unknown; sentinels?: unknown };
          if (typeof body.workspaceId !== "string" || !isUuid(body.workspaceId) || typeof body.permitId !== "string") {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          const resolved = await claims(req, body.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            const selection = await consumePermit(pool, resolved.claim, body.permitId);
            const sentinels = Array.isArray(body.sentinels) ? (body.sentinels as unknown[]).filter((s): s is string => typeof s === "string") : [];
            const record = fakeTransport.send(selection, "test-dispatch", sentinels);
            tenantJson(res, 200, { record, accounts: selection.accounts });
          } catch (err) {
            if (err instanceof PolicyError) {
              const mapped = policyErrorBody(err);
              tenantJson(res, mapped.status, mapped.body);
              return true;
            }
            if (err instanceof Error && err.message.startsWith("fake_provider_tripwire")) {
              tenantJson(res, 500, { error: "transport_tripwire" });
              return true;
            }
            throw err;
          }
          return true;
        }
        // E04-S02 persistent chat: threads/turns/activity are tenant-scoped;
        // foreign or missing ids share one 404 body (no cross-tenant oracle).
        if (path === "/api/chat/threads" && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          const body = (await readJsonBody(req)) as { workspaceId?: unknown; title?: unknown };
          if (typeof body.workspaceId !== "string" || !isUuid(body.workspaceId)) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          const resolved = await claims(req, body.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            tenantJson(res, 201, await createThread(pool, resolved.claim, resolved.claim.userId, { title: body.title }));
          } catch (err) {
            if (err instanceof TenantInvalid) {
              tenantJson(res, 400, { error: "invalid_request" });
              return true;
            }
            if (err instanceof TenantDenied) {
              tenantJson(res, 404, { error: "not_found" });
              return true;
            }
            throw err;
          }
          return true;
        }
        if (path === "/api/chat/threads" && method === "GET") {
          const workspaceId = query.get("workspaceId") ?? "";
          const resolved = await claims(req, workspaceId);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          tenantJson(res, 200, { threads: await listThreads(pool, resolved.claim), requestId });
          return true;
        }
        const threadMatch = path.match(/^\/api\/chat\/threads\/([A-Za-z0-9-]+)$/);
        if (threadMatch && method === "GET") {
          const workspaceId = query.get("workspaceId") ?? "";
          const resolved = await claims(req, workspaceId);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          try {
            const view = await getThread(pool, resolved.claim, threadMatch[1]);
            if (!view) tenantJson(res, 404, { error: "not_found" });
            else tenantJson(res, 200, { ...view, requestId });
          } catch (err) {
            if (err instanceof TenantDenied) tenantJson(res, 404, { error: "not_found" });
            else throw err;
          }
          return true;
        }
        const sendMatch = path.match(/^\/api\/chat\/threads\/([A-Za-z0-9-]+)\/send$/);
        if (sendMatch && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          const body = (await readJsonBody(req)) as { workspaceId?: unknown; body?: unknown; idempotencyKey?: unknown };
          if (typeof body.workspaceId !== "string" || !isUuid(body.workspaceId)) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          const resolved = await claims(req, body.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            tenantJson(res, 202, await sendTurn(pool, resolved.claim, resolved.claim.userId, { threadId: sendMatch[1], body: body.body, idempotencyKey: body.idempotencyKey }));
          } catch (err) {
            if (err instanceof ChatError) {
              const mapped = chatErrorBody(err);
              tenantJson(res, mapped.status, mapped.body);
              return true;
            }
            if (err instanceof TenantInvalid) {
              tenantJson(res, 400, { error: "invalid_request" });
              return true;
            }
            if (err instanceof TenantDenied) {
              tenantJson(res, 404, { error: "not_found" });
              return true;
            }
            throw err;
          }
          return true;
        }
        const activityMatch = path.match(/^\/api\/chat\/threads\/([A-Za-z0-9-]+)\/activity$/);
        if (activityMatch && method === "GET") {
          const workspaceId = query.get("workspaceId") ?? "";
          const resolved = await claims(req, workspaceId);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          const after = query.get("after") ?? "0";
          const limit = query.get("limit") ?? "100";
          try {
            tenantJson(res, 200, { ...(await readActivity(pool, resolved.claim, activityMatch[1], Number(after), Number(limit))), requestId });
          } catch (err) {
            if (err instanceof TenantInvalid) tenantJson(res, 400, { error: "invalid_request" });
            else if (err instanceof TenantDenied) tenantJson(res, 404, { error: "not_found" });
            else throw err;
          }
          return true;
        }
        const cancelMatch = path.match(/^\/api\/chat\/turns\/([A-Za-z0-9-]+)\/cancel$/);
        if (cancelMatch && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          const body = (await readJsonBody(req)) as { workspaceId?: unknown };
          if (typeof body.workspaceId !== "string" || !isUuid(body.workspaceId)) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          const resolved = await claims(req, body.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            tenantJson(res, 200, await cancelTurn(pool, resolved.claim, cancelMatch[1]));
          } catch (err) {
            if (err instanceof TenantDenied) tenantJson(res, 404, { error: "not_found" });
            else throw err;
          }
          return true;
        }
        const retryMatch = path.match(/^\/api\/chat\/turns\/([A-Za-z0-9-]+)\/retry$/);
        if (retryMatch && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          const body = (await readJsonBody(req)) as { workspaceId?: unknown; idempotencyKey?: unknown };
          if (typeof body.workspaceId !== "string" || !isUuid(body.workspaceId)) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          const resolved = await claims(req, body.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            tenantJson(res, 200, await retryTurn(pool, resolved.claim, resolved.claim.userId, { turnId: retryMatch[1], idempotencyKey: body.idempotencyKey }));
          } catch (err) {
            if (err instanceof ChatError) {
              const mapped = chatErrorBody(err);
              tenantJson(res, mapped.status, mapped.body);
              return true;
            }
            if (err instanceof TenantInvalid) {
              tenantJson(res, 400, { error: "invalid_request" });
              return true;
            }
            if (err instanceof TenantDenied) {
              tenantJson(res, 404, { error: "not_found" });
              return true;
            }
            throw err;
          }
          return true;
        }
        const accountMatch = path.match(/^\/api\/accounts\/([A-Za-z0-9-]+)$/);
        if (accountMatch && method === "GET") {
          const workspaceId = query.get("workspaceId") ?? "";
          const resolved = await claims(req, workspaceId);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          const account = await getAccountView(pool, resolved.claim, accountMatch[1]);
          if (!account) tenantJson(res, 404, { error: "not_found" });
          else tenantJson(res, 200, account);
          return true;
        }
        // E02-S01 durable jobs: POST accept (idempotent), GET read. Both
        // enforce session -> membership -> withTenant; foreign and missing
        // job ids share one 404 body.
        const importJobsMatch = path.match(/^\/api\/workspaces\/([A-Za-z0-9-]+)\/import-jobs$/);
        if (importJobsMatch && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          const workspaceId = importJobsMatch[1];
          let input: ReturnType<typeof validateAcceptInput>;
          try {
            const body = (await readJsonBody(req)) as { idempotencyKey?: unknown; label?: unknown };
            input = validateAcceptInput({ workspaceId, idempotencyKey: body.idempotencyKey, ...(body.label === undefined ? {} : { label: body.label }) });
          } catch (err) {
            if (err instanceof TenantInvalid || (err instanceof Error && (err.message === "body_too_large" || err.message === "body_invalid"))) {
              tenantJson(res, 400, { error: "invalid_request" });
              return true;
            }
            throw err;
          }
          const resolved = await claims(req, workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            const result = await acceptImportJob(pool, resolved.claim, resolved.claim.userId, input);
            tenantJson(res, result.replayed ? 200 : 201, { job: result.view, operationId: result.operationId, jobId: result.jobId, replayed: result.replayed, requestId });
          } catch (err) {
            if (err instanceof JobError) {
              const mapped = jobErrorBody(err);
              tenantJson(res, mapped.status, mapped.body);
              return true;
            }
            throw err;
          }
          return true;
        }
        const jobReadMatch = path.match(/^\/api\/workspaces\/([A-Za-z0-9-]+)\/jobs\/([A-Za-z0-9-]+)$/);
        if (jobReadMatch && method === "GET") {
          const resolved = await claims(req, jobReadMatch[1]);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          const job = await readJob(pool, resolved.claim, jobReadMatch[2]);
          if (!job) tenantJson(res, 404, { error: "not_found" });
          else tenantJson(res, 200, { job, requestId });
          return true;
        }
        const jobCancelMatch = path.match(/^\/api\/workspaces\/([A-Za-z0-9-]+)\/jobs\/([A-Za-z0-9-]+)\/cancel$/);
        if (jobCancelMatch && method === "POST") {
          // Cooperative durable cancel: idempotent; foreign/missing ids
          // share the uniform 404 body. The (empty) body is drained so the
          // socket stays reusable for keep-alive HTTP clients.
          try {
            await readJsonBody(req);
          } catch (err) {
            if (err instanceof Error && (err.message === "body_too_large" || err.message === "body_invalid")) {
              tenantJson(res, 400, { error: "invalid_request" });
              return true;
            }
            throw err;
          }
          const resolved = await claims(req, jobCancelMatch[1]);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          const outcome = await cancelJob(pool, resolved.claim, jobCancelMatch[2]);
          if (!outcome) tenantJson(res, 404, { error: "not_found" });
          else tenantJson(res, 200, { status: outcome.status, changed: outcome.changed, effectApplied: outcome.effectApplied, requestId });
          return true;
        }
        // E02-S03 quarantine uploads. Disabled by default (UPLOADS_ENABLED +
        // S3 + scanner config): without it the endpoint hides as 404.
        const uploadsMatch = path.match(/^\/api\/workspaces\/([A-Za-z0-9-]+)\/uploads$/);
        if (uploadsMatch && method === "POST") {
          let config;
          try {
            config = loadUploadConfig();
          } catch {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          const session = await resolveSession(req);
          if (!session) {
            // Drain the unread body so the socket stays reusable.
            req.resume();
            req.on("error", () => {});
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          const workspaceId = uploadsMatch[1];
          const resolved = await claims(req, workspaceId);
          if (!resolved.claim) {
            req.resume();
            req.on("error", () => {});
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          let form;
          try {
            form = await readMultipart(req, { maxBytes: MAX_UPLOAD_BYTES + 64 * 1024 });
          } catch (err) {
            if (err instanceof Error && err.message === "body_too_large") {
              tenantJson(res, 413, { error: "payload_too_large", reason: "upload-limit" });
              return true;
            }
            tenantJson(res, 400, { error: "invalid_request" });
            return true;
          }
          try {
            if (!form.file) throw new UploadError("invalid_request", "missing-file");
            if (typeof form.fields["idempotencyKey"] !== "string" || !isUuid(form.fields["idempotencyKey"])) {
              throw new UploadError("invalid_request", "bad-idempotency-key");
            }
            let profile: unknown;
            if (form.fields["profile"] !== undefined) {
              try {
                profile = JSON.parse(form.fields["profile"]);
              } catch {
                throw new UploadError("invalid_request", "bad-profile");
              }
            }
            const result = await acceptUpload(pool, resolved.claim, resolved.claim.userId, config, {
              workspaceId,
              idempotencyKey: form.fields["idempotencyKey"],
              filename: form.file.filename,
              bytes: form.file.bytes,
              profile,
            });
            tenantJson(res, result.replayed ? 200 : 201, { import: result.import, jobId: result.jobId, replayed: result.replayed, requestId });
          } catch (err) {
            if (err instanceof UploadError) {
              const mapped = uploadErrorBody(err);
              tenantJson(res, mapped.status, mapped.body);
              return true;
            }
            throw err;
          }
          return true;
        }
        const importReadMatch = path.match(/^\/api\/workspaces\/([A-Za-z0-9-]+)\/imports\/([A-Za-z0-9-]+)$/);
        if (importReadMatch && method === "GET") {
          const resolved = await claims(req, importReadMatch[1]);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          const viewed = await readImport(pool, resolved.claim, importReadMatch[2]);
          if (!viewed) tenantJson(res, 404, { error: "not_found" });
          else tenantJson(res, 200, { import: viewed, requestId });
          return true;
        }
        const observationsMatch = path.match(/^\/api\/workspaces\/([A-Za-z0-9-]+)\/imports\/([A-Za-z0-9-]+)\/observations$/);
        if (observationsMatch && method === "GET") {
          const resolved = await claims(req, observationsMatch[1]);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          const limit = query.get("limit");
          const offset = query.get("offset");
          try {
            const page = await listObservations(pool, resolved.claim, observationsMatch[2], {
              ...(limit === null ? {} : { limit: Number(limit) }),
              ...(offset === null ? {} : { offset: Number(offset) }),
            });
            // Unknown import reads as an empty page (uniform with missing).
            tenantJson(res, 200, { ...page, requestId });
          } catch (err) {
            if (err instanceof TenantInvalid) {
              tenantJson(res, 400, { error: "invalid_request" });
              return true;
            }
            throw err;
          }
          return true;
        }
        // E02-S05 import commit: POST to start commit job, GET status.
        const importCommitMatch = path.match(/^\/api\/workspaces\/([A-Za-z0-9-]+)\/imports\/([A-Za-z0-9-]+)\/commit$/);
        if (importCommitMatch && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          let input: { workspaceId: string; idempotencyKey: string; importId: string; accountId: string };
          try {
            const body = (await readJsonBody(req)) as { idempotencyKey?: unknown; accountId?: unknown };
            if (typeof body.idempotencyKey !== "string" || !isUuid(body.idempotencyKey) || typeof body.accountId !== "string" || !isUuid(body.accountId)) {
              tenantJson(res, 400, { error: "invalid_request" });
              return true;
            }
            input = { workspaceId: importCommitMatch[1], idempotencyKey: body.idempotencyKey, importId: importCommitMatch[2], accountId: body.accountId };
          } catch (err) {
            if (err instanceof Error && (err.message === "body_too_large" || err.message === "body_invalid")) {
              tenantJson(res, 400, { error: "invalid_request" });
              return true;
            }
            throw err;
          }
          const resolved = await claims(req, input.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            const result = await acceptImportCommitJob(pool, resolved.claim, resolved.claim.userId, input);
            tenantJson(res, result.replayed ? 200 : 201, { job: result.view, operationId: result.operationId, jobId: result.jobId, replayed: result.replayed, requestId });
          } catch (err) {
            if (err instanceof ImportCommitError) {
              const mapped = importCommitErrorBody(err);
              tenantJson(res, mapped.status, mapped.body);
              return true;
            }
            throw err;
          }
          return true;
        }
        const importCommitReadMatch = path.match(/^\/api\/workspaces\/([A-Za-z0-9-]+)\/imports\/([A-Za-z0-9-]+)\/commit$/);
        if (importCommitReadMatch && method === "GET") {
          const resolved = await claims(req, importCommitReadMatch[1]);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          const status = await readImportCommitStatus(pool, resolved.claim, importCommitReadMatch[2]);
          if (!status) tenantJson(res, 404, { error: "not_found" });
          else tenantJson(res, 200, { commit: status, requestId });
          return true;
        }
        // E02-S04 mapping: propose (deterministic first, bounded model
        // assistance when configured), accept with corrections, read current.
        const mappingProposeMatch = path.match(/^\/api\/workspaces\/([A-Za-z0-9-]+)\/imports\/([A-Za-z0-9-]+)\/mapping$/);
        if (mappingProposeMatch && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          const resolved = await claims(req, mappingProposeMatch[1]);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          let body: { mode?: unknown; replace?: unknown };
          try {
            body = (await readJsonBody(req)) as { mode?: unknown; replace?: unknown };
          } catch {
            tenantJson(res, 400, { error: "invalid_request" });
            return true;
          }
          if (body.mode !== undefined && body.mode !== "auto" && body.mode !== "manual") {
            tenantJson(res, 400, { error: "invalid_request" });
            return true;
          }
          try {
            const provider = body.mode === "manual" ? null : loadMappingProvider();
            const result = await proposeMapping(pool, resolved.claim, mappingProposeMatch[2], {
              transport: provider ? liveMappingTransport(provider) : null,
              ...(body.replace === true ? { replace: true as const } : {}),
            });
            tenantJson(res, result.replayed ? 200 : 201, { proposal: result.proposal, aiUsed: result.aiUsed, ...(result.fallback ? { fallback: result.fallback } : {}), replayed: result.replayed, requestId });
          } catch (err) {
            if (err instanceof MappingError) {
              const mapped = mappingErrorBody(err);
              tenantJson(res, mapped.status, mapped.body);
              return true;
            }
            throw err;
          }
          return true;
        }
        const mappingReadMatch = path.match(/^\/api\/workspaces\/([A-Za-z0-9-]+)\/imports\/([A-Za-z0-9-]+)\/mapping$/);
        if (mappingReadMatch && method === "GET") {
          const resolved = await claims(req, mappingReadMatch[1]);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          const current = await readCurrentMapping(pool, resolved.claim, mappingReadMatch[2]);
          if (!current) tenantJson(res, 404, { error: "not_found" });
          else tenantJson(res, 200, { proposal: current, requestId });
          return true;
        }
        const mappingAcceptMatch = path.match(/^\/api\/workspaces\/([A-Za-z0-9-]+)\/imports\/([A-Za-z0-9-]+)\/mapping\/accept$/);
        if (mappingAcceptMatch && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          const resolved = await claims(req, mappingAcceptMatch[1]);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          let body: unknown;
          try {
            body = await readJsonBody(req);
          } catch {
            tenantJson(res, 400, { error: "invalid_request" });
            return true;
          }
          try {
            const result = await acceptMapping(pool, resolved.claim, mappingAcceptMatch[2], body as { proposalId: string });
            tenantJson(res, 200, { ...result, requestId });
          } catch (err) {
            if (err instanceof MappingError) {
              const mapped = mappingErrorBody(err);
              tenantJson(res, mapped.status, mapped.body);
              return true;
            }
            throw err;
          }
          return true;
        }
        const profilesMatch = path.match(/^\/api\/workspaces\/([A-Za-z0-9-]+)\/mapping-profiles$/);
        if (profilesMatch && method === "GET") {
          const resolved = await claims(req, profilesMatch[1]);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          const name = query.get("name");
          if (name !== null && (name.length < 1 || name.length > 120)) {
            tenantJson(res, 400, { error: "invalid_request" });
            return true;
          }
          tenantJson(res, 200, { profiles: await listMappingProfiles(pool, resolved.claim, name ?? undefined), requestId });
          return true;
        }
        // E05-S01 artifacts: create draft, submit build, read version, list versions, activate, list artifacts
        if (path === "/api/artifacts" && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          const body = (await readJsonBody(req)) as { workspaceId?: unknown; name?: unknown; description?: unknown };
          if (typeof body.workspaceId !== "string" || !isUuid(body.workspaceId)) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          const resolved = await claims(req, body.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            tenantJson(res, 201, await withTenant(pool, resolved.claim, async (client) => createArtifactDraft(client, resolved.claim!, body.name as string, body.description as string | undefined)));
          } catch (err) {
            if (err instanceof TenantInvalid) {
              tenantJson(res, 400, { error: "invalid_request" });
              return true;
            }
            throw err;
          }
          return true;
        }
        if (path === "/api/artifacts" && method === "GET") {
          const workspaceId = query.get("workspaceId") ?? "";
          const resolved = await claims(req, workspaceId);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          tenantJson(res, 200, { artifacts: await withTenant(pool, resolved.claim, async (client) => listArtifacts(client, resolved.claim!)), requestId });
          return true;
        }
        const artifactMatch = path.match(/^\/api\/artifacts\/([A-Za-z0-9-]+)$/);
        if (artifactMatch && method === "GET") {
          const workspaceId = query.get("workspaceId") ?? "";
          const resolved = await claims(req, workspaceId);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          const artifact = await withTenant(pool, resolved.claim, async (client) => getArtifact(client, resolved.claim!, artifactMatch[1]));
          if (!artifact) tenantJson(res, 404, { error: "not_found" });
          else tenantJson(res, 200, artifact);
          return true;
        }
        if (path === "/api/artifacts/build" && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          const body = (await readJsonBody(req)) as { workspaceId?: unknown; artifactId?: unknown; source?: unknown; manifest?: unknown };
          if (typeof body.workspaceId !== "string" || !isUuid(body.workspaceId) || typeof body.artifactId !== "string" || !isUuid(body.artifactId) || typeof body.source !== "object" || body.source === null || typeof body.manifest !== "object" || body.manifest === null) {
            tenantJson(res, 400, { error: "invalid_request" });
            return true;
          }
          const artifactId = body.artifactId as string;
          const source = body.source as { html: string; css: string; js: string };
          const manifest = body.manifest as { artifactSdkVersion: string; runtimeVersion: string; sourceSchemaVersion: string; stateSchemaVersion: string; requestedPermissions: string[]; approvedPermissions: string[]; entrypoints: { full: string; compact: string }; resourceBudget: Record<string, number>; sourceHash: string; buildHash: string; createdByAIRun?: string; createdByUser?: string };
          const resolved = await claims(req, body.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            tenantJson(res, 201, await withTenant(pool, resolved.claim, async (client) => submitArtifactBuild(client, resolved.claim!, artifactId, source, manifest)));
          } catch (err) {
            if (err instanceof TenantInvalid) {
              tenantJson(res, 400, { error: "invalid_request" });
              return true;
            }
            throw err;
          }
          return true;
        }
        const versionMatch = path.match(/^\/api\/artifacts\/([A-Za-z0-9-]+)\/versions\/([A-Za-z0-9-]+)$/);
        if (versionMatch && method === "GET") {
          const workspaceId = query.get("workspaceId") ?? "";
          const resolved = await claims(req, workspaceId);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          const version = await withTenant(pool, resolved.claim, async (client) => getArtifactVersion(client, resolved.claim!, versionMatch[1], versionMatch[2]));
          if (!version) tenantJson(res, 404, { error: "not_found" });
          else tenantJson(res, 200, version);
          return true;
        }
        const versionsMatch = path.match(/^\/api\/artifacts\/([A-Za-z0-9-]+)\/versions$/);
        if (versionsMatch && method === "GET") {
          const workspaceId = query.get("workspaceId") ?? "";
          const resolved = await claims(req, workspaceId);
          if (!resolved.claim) {
            denied(res, resolved.session !== null);
            return true;
          }
          tenantJson(res, 200, { versions: await withTenant(pool, resolved.claim, async (client) => listArtifactVersions(client, resolved.claim!, versionsMatch[1])), requestId });
          return true;
        }
        const activateMatch = path.match(/^\/api\/artifacts\/([A-Za-z0-9-]+)\/activate$/);
        if (activateMatch && method === "POST") {
          const session = await resolveSession(req);
          if (!session) {
            tenantJson(res, 401, { error: "unauthorized" });
            return true;
          }
          const body = (await readJsonBody(req)) as { workspaceId?: unknown; versionId?: unknown; expectedActiveVersionId?: unknown };
          if (typeof body.workspaceId !== "string" || !isUuid(body.workspaceId) || typeof body.versionId !== "string" || !isUuid(body.versionId)) {
            tenantJson(res, 400, { error: "invalid_request" });
            return true;
          }
          const versionId = body.versionId as string;
          const expectedActiveVersionId = body.expectedActiveVersionId as string | undefined;
          const resolved = await claims(req, body.workspaceId);
          if (!resolved.claim) {
            tenantJson(res, 404, { error: "not_found" });
            return true;
          }
          try {
            const result = await withTenant(pool, resolved.claim, async (client) => activateArtifactVersion(client, resolved.claim!, activateMatch[1], versionId, expectedActiveVersionId));
            tenantJson(res, 200, result);
          } catch (err) {
            if (err instanceof TenantInvalid) {
              tenantJson(res, 400, { error: "invalid_request" });
              return true;
            }
            if (err instanceof Error && err.message === "VERSION_MISMATCH") {
              tenantJson(res, 409, { error: "conflict", reason: "version_mismatch" });
              return true;
            }
            if (err instanceof Error && err.message === "VERSION_NOT_FOUND") {
              tenantJson(res, 404, { error: "not_found" });
              return true;
            }
            if (err instanceof Error && err.message === "VERSION_NOT_READY") {
              tenantJson(res, 409, { error: "conflict", reason: "version_not_ready" });
              return true;
            }
            if (err instanceof Error && err.message === "ARTIFACT_NOT_FOUND") {
              tenantJson(res, 404, { error: "not_found" });
              return true;
            }
            throw err;
          }
          return true;
        }
      } catch (err) {
        if (err instanceof TenantDenied) {
          tenantJson(res, 404, { error: "not_found" });
          return true;
        }
        if (err instanceof TenantInvalid || (err instanceof Error && (err.message === "body_too_large" || err.message === "body_invalid"))) {
          tenantJson(res, 400, { error: "invalid_request" });
          return true;
        }
        throw err;
      }
      return false;
    },
  };
}

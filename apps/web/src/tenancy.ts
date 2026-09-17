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
import { CommandError, getAccountView, listAccountViews, renameAccount, validateRenameInput } from "./commands/accounts.ts";
import { consumePermit, getPolicy, issuePermit, PolicyError, setAccountExclusion, summarizeEligible } from "./ai-policy.ts";
import { createFakeProvider } from "./ai-fake-provider.ts";

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
export async function withTenant<T>(pool: Pool, claims: TenantClaims, work: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!isUuid(claims.userId) || !isUuid(claims.workspaceId)) throw new TenantDenied();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
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
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 64 * 1024) reject(new Error("body_too_large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? (JSON.parse(data) as unknown) : {});
      } catch {
        reject(new Error("body_invalid"));
      }
    });
    req.on("error", reject);
  });
}

export type TenancyRouter = {
  handle: (req: IncomingMessage, res: ServerResponse, path: string, method: string, query: URLSearchParams) => Promise<boolean>;
};

// Test-transport log only (dies with the process). Bounded so a long-lived
// dev server cannot grow it without limit; E02/E04 replace this transport.
const fakeTransport = createFakeProvider(200);

function policyErrorBody(err: PolicyError): { status: number; body: unknown } {
  if (err.code === "unknown_account") return { status: 400, body: { error: "invalid_request", reason: err.code } };
  return { status: 409, body: { error: "conflict", reason: err.code } };
}

export function createTenancyRouter(pool: Pool, resolveSession: SessionResolver): TenancyRouter {
  // Every route resolves the session first (uniform 401), then the user row,
  // then membership inside withTenant. Missing and foreign resources share
  // one 404 body so callers cannot distinguish them.
  async function claims(req: IncomingMessage, workspaceId: string): Promise<{ session: Session | null; claim: TenantClaims | null }> {
    // Single session resolution per call: the caller branches on session
    // (401) versus claim (404) without a second roundtrip.
    const session = await resolveSession(req);
    if (!session || !isUuid(workspaceId)) return { session, claim: null };
    const found = await pool.query("SELECT id FROM users WHERE auth_subject = $1", [session.keycloakSub]);
    if ((found.rowCount ?? 0) === 0) return { session, claim: null };
    return { session, claim: { userId: (found.rows[0] as { id: string }).id, workspaceId } };
  }

  function denied(res: ServerResponse, authed: boolean): void {
    // Authenticated-but-denied shares one body with missing resources so
    // callers cannot distinguish foreign from absent; unauthenticated callers
    // get the auth boundary's 401 instead.
    if (authed) tenantJson(res, 404, { error: "not_found" });
    else tenantJson(res, 401, { error: "unauthorized" });
  }

  return {
    handle: async (req, res, path, method, query) => {
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

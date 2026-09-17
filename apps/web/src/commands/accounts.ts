// E01-S04 first consumed command/read contract (architecture §§47–49,
// §§60–63). One domain module, one JSON Schema source, HTTP adapter only
// (AI/artifact adapters consume this same module later). Intent-based
// `accounts.rename` with idempotency journal + optimistic versions; reads
// never mutate. Versions cross JSON strictly as decimal strings.

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { isUuid, uuidv7 } from "../ids.ts";
import { formatDecimalBigint, parseDecimalBigint } from "../money.ts";
import { TenantDenied, TenantInvalid, withTenant, type TenantClaims } from "../tenancy.ts";

export const RENAME_COMMAND = "accounts.rename";
const REPLAY_RETENTION_DAYS = 30;

export type RenameInput = {
  workspaceId: string;
  accountId: string;
  name: string;
  expectedVersion: string; // decimal string
  idempotencyKey: string; // UUID
};

export type AccountView = { workspaceId: string; id: string; name: string; version: string };

export type CommandResult = { view: AccountView; operationId: string; replayed: boolean };

// Single contract source (§49): JSON Schema Draft 2020-12 objects consumed
// by the HTTP validator and (later) AI/artifact adapters alike.
export const renameInputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://moneo.invalid/schemas/accounts.rename.input",
  type: "object",
  additionalProperties: false,
  required: ["workspaceId", "accountId", "name", "expectedVersion", "idempotencyKey"],
  properties: {
    workspaceId: { type: "string", format: "uuid" },
    accountId: { type: "string", format: "uuid" },
    name: { type: "string", minLength: 1, maxLength: 200 },
    expectedVersion: { type: "string", pattern: "^[0-9]+$" },
    idempotencyKey: { type: "string", format: "uuid" },
  },
} as const;

export const accountViewSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://moneo.invalid/schemas/account.view",
  type: "object",
  additionalProperties: false,
  required: ["workspaceId", "id", "name", "version"],
  properties: {
    workspaceId: { type: "string", format: "uuid" },
    id: { type: "string", format: "uuid" },
    name: { type: "string", minLength: 1, maxLength: 200 },
    version: { type: "string", pattern: "^[0-9]+$" },
  },
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Minimal validator derived from the contract objects above (no new deps). */
export function validateRenameInput(value: unknown): RenameInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!["workspaceId", "accountId", "name", "expectedVersion", "idempotencyKey"].includes(key)) throw new TenantInvalid();
  }
  const { workspaceId, accountId, name, expectedVersion, idempotencyKey } = v;
  if (typeof workspaceId !== "string" || !UUID_RE.test(workspaceId)) throw new TenantInvalid();
  if (typeof accountId !== "string" || !UUID_RE.test(accountId)) throw new TenantInvalid();
  if (typeof name !== "string" || name.length < 1 || name.length > 200) throw new TenantInvalid();
  if (typeof expectedVersion !== "string" || !/^[0-9]+$/.test(expectedVersion)) throw new TenantInvalid();
  if (typeof idempotencyKey !== "string" || !UUID_RE.test(idempotencyKey)) throw new TenantInvalid();
  return { workspaceId, accountId, name, expectedVersion, idempotencyKey };
}

/** Canonical request hash: same intent always hashes identically (§60 rule 2–3). */
export function requestHash(input: RenameInput): string {
  const canonical = JSON.stringify({
    accountId: input.accountId,
    expectedVersion: input.expectedVersion,
    idempotencyKey: undefined, // the key scopes the journal row, not the hashed intent
    name: input.name,
    workspaceId: input.workspaceId,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export class CommandError extends Error {
  readonly code: "version_mismatch" | "idempotency_reuse" | "idempotency_expired" | "not_found";
  readonly currentVersion?: string;
  constructor(code: CommandError["code"], currentVersion?: string) {
    super(code);
    this.code = code;
    this.currentVersion = currentVersion;
  }
}

function rowToView(row: { workspace_id: string; id: string; name: string; version: string }): AccountView {
  // pg returns BIGINT as a decimal string already; re-format to guarantee
  // canonical shape rather than trusting driver output.
  return { workspaceId: row.workspace_id, id: row.id, name: row.name, version: formatDecimalBigint(BigInt(row.version)) };
}

/**
 * Execute accounts.rename idempotently inside the caller's transaction
 * (claim + effect commit together per §61; crash rolls both back).
 * Must run under withTenant context for the target workspace.
 */
export async function renameAccountTx(client: PoolClient, claims: TenantClaims, actorId: string, input: RenameInput): Promise<CommandResult> {
  let expected: bigint;
  try {
    expected = parseDecimalBigint(input.expectedVersion);
  } catch {
    throw new TenantInvalid();
  }
  const hash = requestHash(input);

  // Fast path: a terminal record for this key already exists.
  const prior = await client.query(
    "SELECT id AS \"operationId\", status, request_hash AS \"requestHash\", response_payload AS \"response\", error_payload AS \"error\", expires_at AS \"expiresAt\" FROM command_operations WHERE workspace_id = $1 AND command_name = $2 AND idempotency_key = $3",
    [claims.workspaceId, RENAME_COMMAND, input.idempotencyKey],
  );
  if ((prior.rowCount ?? 0) > 0) {
    const row = prior.rows[0] as { operationId: string; status: string; requestHash: string; response: unknown; error: { code: CommandError["code"]; currentVersion?: string } | null; expiresAt: string };
    if (new Date(row.expiresAt).getTime() <= Date.now()) throw new CommandError("idempotency_expired");
    if (row.requestHash !== hash) throw new CommandError("idempotency_reuse");
    if (row.status === "SUCCEEDED") return { view: row.response as AccountView, operationId: row.operationId, replayed: true };
    throw new CommandError(row.error?.code ?? "version_mismatch", row.error?.currentVersion);
  }

  // Claim the key before executing so concurrent duplicates converge here.
  const operationId = uuidv7();
  try {
    await client.query(
      "INSERT INTO command_operations (workspace_id, id, command_name, idempotency_key, request_hash, actor_id, status, expires_at) VALUES ($1, $2, $3, $4, $5, $6, 'FAILED_FINAL', now() + ($7 || ' days')::interval)",
      [claims.workspaceId, operationId, RENAME_COMMAND, input.idempotencyKey, hash, actorId, String(REPLAY_RETENTION_DAYS)],
    );
  } catch (err) {
    if ((err as { code?: string }).code !== "23505") throw err;
    // Lost the race: the winner's row becomes visible on commit, so poll
    // briefly before concluding. A rolled-back winner stays invisible and the
    // caller retries the same key into a fresh claim.
    let row: { operationId: string; status: string; requestHash: string; response: unknown; error: { code: CommandError["code"]; currentVersion?: string } | null; expiresAt: string } | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      const winner = await client.query(
        "SELECT id AS \"operationId\", status, request_hash AS \"requestHash\", response_payload AS \"response\", error_payload AS \"error\", expires_at AS \"expiresAt\" FROM command_operations WHERE workspace_id = $1 AND command_name = $2 AND idempotency_key = $3",
        [claims.workspaceId, RENAME_COMMAND, input.idempotencyKey],
      );
      row = winner.rows[0] as typeof row;
      if (row) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!row) throw new CommandError("version_mismatch");
    if (new Date(row.expiresAt).getTime() <= Date.now()) throw new CommandError("idempotency_expired");
    if (row.requestHash !== hash) throw new CommandError("idempotency_reuse");
    if (row.status === "SUCCEEDED") return { view: row.response as AccountView, operationId: row.operationId, replayed: true };
    throw new CommandError(row.error?.code ?? "version_mismatch", row.error?.currentVersion);
  }

  const fail = async (code: CommandError["code"], currentVersion?: string): Promise<never> => {
    await client.query("UPDATE command_operations SET status = 'FAILED_FINAL', error_payload = $1, completed_at = now() WHERE workspace_id = $2 AND id = $3", [
      JSON.stringify(currentVersion === undefined ? { code } : { code, currentVersion }),
      claims.workspaceId,
      operationId,
    ]);
    throw new CommandError(code, currentVersion);
  };

  // Single atomic compare-and-swap: no TOCTOU between check and mutate.
  const updated = await client.query(
    "UPDATE accounts SET name = $1, version = version + 1, updated_at = now() WHERE workspace_id = $2 AND id = $3 AND version = $4 RETURNING workspace_id, id, name, version",
    [input.name, claims.workspaceId, input.accountId, expected.toString(10)],
  );
  if ((updated.rowCount ?? 0) === 0) {
    const current = await client.query("SELECT version FROM accounts WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, input.accountId]);
    if ((current.rowCount ?? 0) === 0) return fail("not_found");
    return fail("version_mismatch", formatDecimalBigint(BigInt((current.rows[0] as { version: string }).version)));
  }
  const view = rowToView(updated.rows[0] as { workspace_id: string; id: string; name: string; version: string });
  await client.query("UPDATE command_operations SET status = 'SUCCEEDED', response_payload = $1, completed_at = now() WHERE workspace_id = $2 AND id = $3", [
    JSON.stringify(view),
    claims.workspaceId,
    operationId,
  ]);
  return { view, operationId, replayed: false };
}

export async function renameAccount(
  pool: Parameters<typeof withTenant>[0],
  claims: TenantClaims,
  actorId: string,
  raw: unknown,
): Promise<CommandResult> {
  const input = validateRenameInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  if (!isUuid(input.accountId)) throw new TenantDenied();
  return withTenant(pool, claims, (client) => renameAccountTx(client, claims, actorId, input));
}

export async function getAccountView(pool: Parameters<typeof withTenant>[0], claims: TenantClaims, accountId: string): Promise<AccountView | null> {
  if (!isUuid(accountId)) return null;
  return withTenant(pool, claims, async (client) => {
    const rows = await client.query("SELECT workspace_id, id, name, version FROM accounts WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, accountId]);
    if ((rows.rowCount ?? 0) === 0) return null;
    return rowToView(rows.rows[0] as { workspace_id: string; id: string; name: string; version: string });
  });
}

export async function listAccountViews(pool: Parameters<typeof withTenant>[0], claims: TenantClaims): Promise<AccountView[]> {
  return withTenant(pool, claims, async (client) => {
    const rows = await client.query("SELECT workspace_id, id, name, version FROM accounts WHERE workspace_id = $1 ORDER BY created_at", [claims.workspaceId]);
    return (rows.rows as { workspace_id: string; id: string; name: string; version: string }[]).map(rowToView);
  });
}

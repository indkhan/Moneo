// E03-S04 calculation evidence and workspace data revision commands.
// Immutable calculation version metadata + coarse workspace revision for derived read invalidation.

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { isUuid, uuidv7 } from "../ids.ts";
import { formatDecimalBigint, parseDecimalBigint } from "../money.ts";
import { TenantDenied, TenantInvalid, withTenant, type TenantClaims } from "../tenancy.ts";

export const BUMP_CALCULATION_VERSION_COMMAND = "calculations.bump_version";
export const BUMP_WORKSPACE_REVISION_COMMAND = "workspace.bump_revision";
const REPLAY_RETENTION_DAYS = 30;

export type BumpCalculationVersionInput = {
  workspaceId: string;
  idempotencyKey: string;
};

export type BumpWorkspaceRevisionInput = {
  workspaceId: string;
  idempotencyKey: string;
};

export type CalculationVersionView = {
  workspaceId: string;
  version: string;
  inputsHash: string;
  resultsHash: string;
  createdAt: string;
};

export type WorkspaceRevisionView = {
  workspaceId: string;
  revision: string;
  updatedAt: string;
};

export type BumpCalculationVersionResult = { view: CalculationVersionView; operationId: string; replayed: boolean };
export type BumpWorkspaceRevisionResult = { view: WorkspaceRevisionView; operationId: string; replayed: boolean };

export const bumpCalculationVersionInputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://moneo.invalid/schemas/calculations.bump_version.input",
  type: "object",
  additionalProperties: false,
  required: ["workspaceId", "idempotencyKey"],
  properties: {
    workspaceId: { type: "string", format: "uuid" },
    idempotencyKey: { type: "string", format: "uuid" },
  },
} as const;

export const bumpWorkspaceRevisionInputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://moneo.invalid/schemas/workspace.bump_revision.input",
  type: "object",
  additionalProperties: false,
  required: ["workspaceId", "idempotencyKey"],
  properties: {
    workspaceId: { type: "string", format: "uuid" },
    idempotencyKey: { type: "string", format: "uuid" },
  },
} as const;

export const calculationVersionViewSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://moneo.invalid/schemas/calculation_version.view",
  type: "object",
  additionalProperties: false,
  required: ["workspaceId", "version", "inputsHash", "resultsHash", "createdAt"],
  properties: {
    workspaceId: { type: "string", format: "uuid" },
    version: { type: "string", pattern: "^[0-9]+$" },
    inputsHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    resultsHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

export const workspaceRevisionViewSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://moneo.invalid/schemas/workspace_revision.view",
  type: "object",
  additionalProperties: false,
  required: ["workspaceId", "revision", "updatedAt"],
  properties: {
    workspaceId: { type: "string", format: "uuid" },
    revision: { type: "string", pattern: "^[0-9]+$" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateBumpCalculationVersionInput(value: unknown): BumpCalculationVersionInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!["workspaceId", "idempotencyKey"].includes(key)) throw new TenantInvalid();
  }
  const { workspaceId, idempotencyKey } = v;
  if (typeof workspaceId !== "string" || !UUID_RE.test(workspaceId)) throw new TenantInvalid();
  if (typeof idempotencyKey !== "string" || !UUID_RE.test(idempotencyKey)) throw new TenantInvalid();
  return { workspaceId, idempotencyKey };
}

export function validateBumpWorkspaceRevisionInput(value: unknown): BumpWorkspaceRevisionInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!["workspaceId", "idempotencyKey"].includes(key)) throw new TenantInvalid();
  }
  const { workspaceId, idempotencyKey } = v;
  if (typeof workspaceId !== "string" || !UUID_RE.test(workspaceId)) throw new TenantInvalid();
  if (typeof idempotencyKey !== "string" || !UUID_RE.test(idempotencyKey)) throw new TenantInvalid();
  return { workspaceId, idempotencyKey };
}

function bumpCalculationVersionRequestHash(input: BumpCalculationVersionInput): string {
  const canonical = JSON.stringify({
    idempotencyKey: undefined,
    workspaceId: input.workspaceId,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function bumpWorkspaceRevisionRequestHash(input: BumpWorkspaceRevisionInput): string {
  const canonical = JSON.stringify({
    idempotencyKey: undefined,
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

type StoredOp = {
  operationId: string;
  status: string;
  requestHash: string;
  response: unknown;
  error: { code: CommandError["code"]; currentVersion?: string } | null;
  expiresAt: string;
};

type TxOutcome<T> = { ok: true; result: T; operationId: string; replayed: boolean } | { ok: false; code: CommandError["code"]; currentVersion?: string };

async function claimAndExecute<T>(
  client: PoolClient,
  claims: TenantClaims,
  actorId: string,
  command: string,
  input: { idempotencyKey: string; workspaceId: string },
  hash: string,
  execute: (client: PoolClient, operationId: string) => Promise<{ view: T; operationId: string }>,
): Promise<TxOutcome<T>> {
  const readOp = async (): Promise<StoredOp | undefined> => {
    const found = await client.query(
      "SELECT id AS \"operationId\", status, request_hash AS \"requestHash\", response_payload AS \"response\", error_payload AS \"error\", expires_at AS \"expiresAt\" FROM command_operations WHERE workspace_id = $1 AND command_name = $2 AND idempotency_key = $3",
      [claims.workspaceId, command, input.idempotencyKey],
    );
    return found.rows[0] as StoredOp | undefined;
  };

  const settle = (row: StoredOp): TxOutcome<T> => {
    if (new Date(row.expiresAt).getTime() <= Date.now()) return { ok: false, code: "idempotency_expired" };
    if (row.requestHash !== hash) return { ok: false, code: "idempotency_reuse" };
    if (row.status === "SUCCEEDED") {
      const resp = row.response as { view: T; operationId: string; replayed: boolean };
      return { ok: true, result: resp.view, operationId: resp.operationId, replayed: true };
    }
    return { ok: false, code: row.error?.code ?? "version_mismatch", currentVersion: row.error?.currentVersion };
  };

  const prior = await readOp();
  if (prior) return settle(prior);

  for (let attempt = 0; attempt < 3; attempt++) {
    const operationId = uuidv7();
    await client.query("SAVEPOINT command_claim");
    let claimed = false;
    try {
      await client.query(
        "INSERT INTO command_operations (workspace_id, id, command_name, idempotency_key, request_hash, actor_id, status, expires_at) VALUES ($1, $2, $3, $4, $5, $6, 'FAILED_FINAL', now() + ($7 || ' days')::interval)",
        [claims.workspaceId, operationId, command, input.idempotencyKey, hash, actorId, String(REPLAY_RETENTION_DAYS)],
      );
      claimed = true;
    } catch (err) {
      if ((err as { code?: string }).code !== "23505") throw err;
      await client.query("ROLLBACK TO SAVEPOINT command_claim");
    }
    if (!claimed) {
      let row: StoredOp | undefined;
      for (let poll = 0; poll < 20; poll++) {
        row = await readOp();
        if (row) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (row) return settle(row);
      continue;
    }

    try {
      await client.query("SAVEPOINT command_execute");
      try {
        const { view } = await execute(client, operationId);
        await client.query("UPDATE command_operations SET status = 'SUCCEEDED', response_payload = $1, completed_at = now() WHERE workspace_id = $2 AND id = $3", [
          JSON.stringify({ view, operationId, replayed: false }),
          claims.workspaceId,
          operationId,
        ]);
        return { ok: true, result: view, operationId, replayed: false };
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT command_execute");
        const code = err instanceof CommandError ? err.code : (err as { code?: string }).code === "23503" ? "not_found" : "version_mismatch";
        const currentVersion = err instanceof CommandError ? err.currentVersion : undefined;
        await client.query("UPDATE command_operations SET status = 'FAILED_FINAL', error_payload = $1, completed_at = now() WHERE workspace_id = $2 AND id = $3", [
          JSON.stringify(currentVersion === undefined ? { code } : { code, currentVersion }),
          claims.workspaceId,
          operationId,
        ]);
        return { ok: false, code, currentVersion };
      }
    } catch (err) {
      const code = err instanceof CommandError ? err.code : "version_mismatch";
      const currentVersion = err instanceof CommandError ? err.currentVersion : undefined;
      await client.query("UPDATE command_operations SET status = 'FAILED_FINAL', error_payload = $1, completed_at = now() WHERE workspace_id = $2 AND id = $3", [
        JSON.stringify(currentVersion === undefined ? { code } : { code, currentVersion }),
        claims.workspaceId,
        operationId,
      ]);
      return { ok: false, code, currentVersion };
    }
  }
  throw new Error("command_claim_unsettled");
}

export async function bumpCalculationVersionTx(
  client: PoolClient,
  claims: TenantClaims,
  actorId: string,
  input: BumpCalculationVersionInput,
): Promise<TxOutcome<CalculationVersionView>> {
  void client; void claims; void actorId; void input;
  throw new TenantInvalid();
}

export async function bumpCalculationVersion(
  pool: Parameters<typeof withTenant>[0],
  claims: TenantClaims,
  actorId: string,
  raw: unknown,
): Promise<BumpCalculationVersionResult> {
  const input = validateBumpCalculationVersionInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => bumpCalculationVersionTx(client, claims, actorId, input));
  if (!outcome.ok) throw new CommandError(outcome.code, outcome.currentVersion);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

export async function bumpWorkspaceRevisionTx(
  client: PoolClient,
  claims: TenantClaims,
  actorId: string,
  input: BumpWorkspaceRevisionInput,
): Promise<TxOutcome<WorkspaceRevisionView>> {
  const hash = bumpWorkspaceRevisionRequestHash(input);
  return claimAndExecute(client, claims, actorId, BUMP_WORKSPACE_REVISION_COMMAND, input, hash, async (client, operationId) => {
    const current = await client.query(
      "SELECT revision FROM workspace_data_revision WHERE workspace_id = $1",
      [claims.workspaceId],
    );
    const nextRevision = ((current.rows[0] as { revision: string })?.revision ? BigInt((current.rows[0] as { revision: string }).revision) : 0n) + 1n;

    const revisionStr = nextRevision.toString(10);
    await client.query(
      "INSERT INTO workspace_data_revision (workspace_id, revision, updated_at) VALUES ($1, $2, now()) ON CONFLICT (workspace_id) DO UPDATE SET revision = EXCLUDED.revision, updated_at = now()",
      [claims.workspaceId, nextRevision],
    );

    const view: WorkspaceRevisionView = {
      workspaceId: claims.workspaceId,
      revision: revisionStr,
      updatedAt: new Date().toISOString(),
    };
    return { view, operationId };
  });
}

export async function bumpWorkspaceRevision(
  pool: Parameters<typeof withTenant>[0],
  claims: TenantClaims,
  actorId: string,
  raw: unknown,
): Promise<BumpWorkspaceRevisionResult> {
  const input = validateBumpWorkspaceRevisionInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => bumpWorkspaceRevisionTx(client, claims, actorId, input));
  if (!outcome.ok) throw new CommandError(outcome.code, outcome.currentVersion);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

export async function getCalculationVersion(
  pool: Parameters<typeof withTenant>[0],
  claims: TenantClaims,
): Promise<CalculationVersionView | null> {
  return withTenant(pool, claims, async (client) => {
    const rows = await client.query(
      "SELECT version, inputs_hash, results_hash, created_at FROM calculation_versions WHERE workspace_id = $1 ORDER BY version DESC LIMIT 1",
      [claims.workspaceId],
    );
    if ((rows.rowCount ?? 0) === 0) return null;
    const row = rows.rows[0] as { version: string; inputs_hash: string; results_hash: string; created_at: string };
    return {
      workspaceId: claims.workspaceId,
      version: formatDecimalBigint(BigInt(row.version)),
      inputsHash: row.inputs_hash,
      resultsHash: row.results_hash,
      createdAt: row.created_at,
    };
  });
}

export async function getWorkspaceRevision(
  pool: Parameters<typeof withTenant>[0],
  claims: TenantClaims,
): Promise<WorkspaceRevisionView | null> {
  return withTenant(pool, claims, async (client) => {
    const rows = await client.query(
      "SELECT revision, updated_at FROM workspace_data_revision WHERE workspace_id = $1",
      [claims.workspaceId],
    );
    if ((rows.rowCount ?? 0) === 0) return null;
    const row = rows.rows[0] as { revision: string; updated_at: string };
    return {
      workspaceId: claims.workspaceId,
      revision: formatDecimalBigint(BigInt(row.revision)),
      updatedAt: row.updated_at,
    };
  });
}

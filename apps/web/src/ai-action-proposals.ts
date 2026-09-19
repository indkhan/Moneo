// E04-S05 trusted host confirmation for AI-proposed financial actions
// (product §15; architecture command/consent/security contracts;
// existing transactions.createManual idempotency/audit/undo).
// The AI proposes an action (R1: create manual transaction); the host
// confirms it through the existing command path with full validation.

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isUuid, uuidv7 } from "./ids.ts";
import { TenantDenied, TenantInvalid, withTenant, type TenantClaims } from "./tenancy.ts";
import { formatDecimalBigint, parseDecimalBigint } from "./money.ts";
import { manualTransaction } from "./commands/accounts.ts";

export const PROPOSAL_TTL_MIN = 15;
export const PROPOSAL_KIND = "create_manual_transaction";

export class ProposalError extends Error {
  readonly code:
    | "not_found"
    | "expired"
    | "already_confirmed"
    | "cancelled"
    | "payload_mismatch"
    | "account_mismatch"
    | "version_mismatch"
    | "invalid_payload";
  constructor(code: ProposalError["code"]) {
    super(code);
    this.code = code;
  }
}

export type ProposalPayload = {
  accountId: string;
  amountMinor: string;
  currency: string;
  direction: "INFLOW" | "OUTFLOW";
  effectiveDate: string;
  description: string;
};

export type Proposal = {
  workspaceId: string;
  id: string;
  kind: string;
  payloadHash: string;
  payload: ProposalPayload;
  accountVersion: string;
  proposedBy: string;
  status: "proposed" | "confirmed" | "expired" | "cancelled";
  createdAt: string;
  expiresAt: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
};

function rowToProposal(row: {
  workspace_id: string;
  id: string;
  kind: string;
  payload_hash: string;
  payload: ProposalPayload;
  account_version: string;
  proposed_by: string;
  status: string;
  created_at: unknown;
  expires_at: unknown;
  confirmed_by: string | null;
  confirmed_at: unknown | null;
}): Proposal {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    kind: row.kind,
    payloadHash: row.payload_hash,
    payload: row.payload as ProposalPayload,
    accountVersion: String(row.account_version),
    proposedBy: row.proposed_by,
    status: row.status as Proposal["status"],
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at ? (row.confirmed_at instanceof Date ? row.confirmed_at.toISOString() : String(row.confirmed_at)) : null,
  };
}

export function payloadHash(payload: ProposalPayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export async function createProposal(
  pool: Pool,
  claims: TenantClaims,
  actorId: string,
  payload: ProposalPayload,
): Promise<Proposal> {
  if (!isUuid(actorId)) throw new ProposalError("invalid_payload");
  if (!isUuid(payload.accountId)) throw new ProposalError("invalid_payload");
  if (typeof payload.amountMinor !== "string" || !/^\d+$/.test(payload.amountMinor)) throw new ProposalError("invalid_payload");
  if (payload.currency !== "EUR" && payload.currency !== "USD" && payload.currency !== "JPY" && payload.currency !== "GBP" && payload.currency !== "KWD") throw new ProposalError("invalid_payload");
  if (payload.direction !== "INFLOW" && payload.direction !== "OUTFLOW") throw new ProposalError("invalid_payload");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.effectiveDate)) throw new ProposalError("invalid_payload");
  if (typeof payload.description !== "string" || payload.description.length < 1 || payload.description.length > 500) throw new ProposalError("invalid_payload");

  return withTenant(pool, claims, async (client: PoolClient) => {
    const account = await client.query(
      "SELECT version FROM accounts WHERE workspace_id = $1 AND id = $2",
      [claims.workspaceId, payload.accountId],
    );
    if ((account.rowCount ?? 0) === 0) throw new ProposalError("account_mismatch");
    const accountVersion = String((account.rows[0] as { version: string }).version);

    const id = uuidv7();
    const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const expiresAt = new Date(Date.now() + PROPOSAL_TTL_MIN * 60 * 1000).toISOString();

    await client.query(
      `INSERT INTO ai_action_proposals
       (workspace_id, id, kind, payload_hash, payload, account_version, proposed_by, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'proposed', $8)`,
      [claims.workspaceId, id, PROPOSAL_KIND, hash, JSON.stringify(payload), accountVersion, actorId, expiresAt],
    );

    return {
      workspaceId: claims.workspaceId,
      id,
      kind: PROPOSAL_KIND,
      payloadHash: hash,
      payload,
      accountVersion,
      proposedBy: actorId,
      status: "proposed",
      createdAt: new Date().toISOString(),
      expiresAt,
      confirmedBy: null,
      confirmedAt: null,
    };
  });
}

export async function confirmProposal(
  pool: Pool,
  claims: TenantClaims,
  actorId: string,
  proposalId: string,
  idempotencyKey: string,
): Promise<{ proposal: Proposal; operationId: string }> {
  if (!isUuid(actorId) || !isUuid(proposalId)) throw new TenantDenied();
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 1 || idempotencyKey.length > 200) throw new TenantInvalid();

  return withTenant(pool, claims, async (client: PoolClient) => {
    const proposal = await client.query(
      "SELECT * FROM ai_action_proposals WHERE workspace_id = $1 AND id = $2",
      [claims.workspaceId, proposalId],
    );
    if ((proposal.rowCount ?? 0) === 0) throw new ProposalError("not_found");
    const prop = proposal.rows[0] as { 
      id: string; 
      kind: string; 
      payload_hash: string; 
      payload: any; 
      account_version: string; 
      proposed_by: string; 
      status: string; 
      expires_at: unknown; 
      confirmed_by: string | null; 
      confirmed_at: string | null;
      created_at: unknown;
      created_by: string;
    };
    if (prop.status !== "proposed") throw new ProposalError(prop.status === "confirmed" ? "already_confirmed" : prop.status === "expired" ? "expired" : "cancelled");
    if (new Date(prop.expires_at as string).getTime() <= Date.now()) throw new ProposalError("expired");

    const payload = prop.payload as { accountId: string; amountMinor: string; currency: string; direction: "INFLOW" | "OUTFLOW"; effectiveDate: string; description: string };
    const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    if (prop.payload_hash !== hash) throw new ProposalError("payload_mismatch");

    const account = await client.query("SELECT version FROM accounts WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, payload.accountId]);
    if ((account.rowCount ?? 0) === 0) throw new ProposalError("account_mismatch");
    const currentVersion = String((account.rows[0] as { version: string }).version);
    if (currentVersion !== prop.account_version) throw new ProposalError("version_mismatch");

    const manualInput = {
      workspaceId: claims.workspaceId,
      accountId: payload.accountId,
      amount: payload.amountMinor,
      currency: payload.currency,
      direction: payload.direction,
      effectiveDate: payload.effectiveDate,
      description: payload.description,
      idempotencyKey: uuidv7(),
    };
    const result = await manualTransaction(pool, claims, claims.userId, manualInput);

    const operationId = uuidv7();
    await client.query("UPDATE ai_action_proposals SET status = 'confirmed', confirmed_by = $1, confirmed_at = now(), command_operation_id = $2, idempotency_key = $3 WHERE workspace_id = $4 AND id = $5", [
      actorId, result.operationId, idempotencyKey, claims.workspaceId, proposalId,
    ]);

    return {
      proposal: { 
        workspaceId: claims.workspaceId,
        id: prop.id,
        kind: prop.kind,
        payloadHash: prop.payload_hash,
        payload: prop.payload,
        accountVersion: prop.account_version,
        proposedBy: prop.proposed_by,
        status: "confirmed",
        createdAt: (prop.created_at as unknown) instanceof Date ? (prop.created_at as Date).toISOString() : String(prop.created_at),
        expiresAt: (prop.expires_at as unknown) instanceof Date ? (prop.expires_at as Date).toISOString() : String(prop.expires_at),
        confirmedBy: actorId,
        confirmedAt: new Date().toISOString(),
      },
      operationId: result.operationId,
    };
  });
}

export async function getProposal(pool: Pool, claims: TenantClaims, proposalId: string): Promise<Proposal | null> {
  if (!isUuid(proposalId)) return null;
  return withTenant(pool, claims, async (client: PoolClient) => {
    const found = await client.query("SELECT * FROM ai_action_proposals WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, proposalId]);
    if ((found.rowCount ?? 0) === 0) return null;
    return rowToProposal(found.rows[0] as Parameters<typeof rowToProposal>[0]);
  });
}

export function proposalErrorBody(err: ProposalError): { status: number; body: unknown } {
  switch (err.code) {
    case "not_found": return { status: 404, body: { error: "not_found" } };
    case "expired": return { status: 410, body: { error: "expired" } };
    case "already_confirmed": return { status: 409, body: { error: "already_confirmed" } };
    case "cancelled": return { status: 409, body: { error: "cancelled" } };
    case "payload_mismatch": return { status: 409, body: { error: "payload_mismatch" } };
    case "account_mismatch": return { status: 409, body: { error: "account_mismatch" } };
    case "version_mismatch": return { status: 409, body: { error: "version_mismatch" } };
    case "invalid_payload": return { status: 400, body: { error: "invalid_payload" } };
  }
}
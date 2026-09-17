// E01-S05 shared AI data-selection/dispatch gate (architecture §538).
// Every provider-bound selection flows through here: exclusions are applied
// BEFORE aggregation/evidence/dispatch, permits snapshot eligible inputs
// with the policy version, and dispatch revalidates atomically. Unknown
// accounts default to deny (permits list explicit ids; no wildcards).

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isUuid, uuidv7 } from "./ids.ts";
import { TenantInvalid, withTenant, type TenantClaims } from "./tenancy.ts";

export const PERMIT_TTL_MIN = 15;

export type PolicyState = { policyVersion: string; excludedAccountIds: string[] };

export type Permit = {
  workspaceId: string;
  id: string;
  policyVersion: string;
  eligibleAccountIds: string[];
  purpose: string;
  status: "QUEUED" | "DISPATCHED" | "INVALIDATED";
};

export type EligibleSelection = {
  accounts: { workspaceId: string; id: string; name: string }[];
  provenance: { policyVersion: string; eligibleAccountIds: string[] };
};

export class PolicyError extends Error {
  readonly code: "unknown_account" | "permit_stale" | "permit_consumed" | "permit_expired" | "permit_invalidated";
  constructor(code: PolicyError["code"]) {
    super(code);
    this.code = code;
  }
}

async function currentVersion(client: PoolClient, workspaceId: string): Promise<bigint> {
  const rows = await client.query("SELECT policy_version AS v FROM ai_policies WHERE workspace_id = $1", [workspaceId]);
  if ((rows.rowCount ?? 0) === 0) return 1n;
  return BigInt((rows.rows[0] as { v: string }).v);
}

async function excludedIds(client: PoolClient, workspaceId: string): Promise<string[]> {
  const rows = await client.query("SELECT account_id AS id FROM ai_exclusions WHERE workspace_id = $1 ORDER BY account_id", [workspaceId]);
  return (rows.rows as { id: string }[]).map((r) => r.id);
}

/** Set or clear an account exclusion; bumps the version and invalidates queued permits. Serialized per workspace. */
export async function setAccountExclusion(
  pool: Pool,
  claims: TenantClaims,
  actorId: string,
  accountId: string,
  excluded: boolean,
  reason?: string,
): Promise<PolicyState> {
  if (!isUuid(accountId)) throw new TenantInvalid();
  if (reason !== undefined && (typeof reason !== "string" || reason.length < 1 || reason.length > 200)) throw new TenantInvalid();
  return withTenant(pool, claims, async (client) => {
    const owned = await client.query("SELECT 1 FROM accounts WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, accountId]);
    if ((owned.rowCount ?? 0) === 0) throw new PolicyError("unknown_account");
    // Serialize writers per workspace so versions never skip or duplicate.
    await client.query("INSERT INTO ai_policies (workspace_id, policy_version) VALUES ($1, 1) ON CONFLICT (workspace_id) DO NOTHING", [claims.workspaceId]);
    await client.query("SELECT policy_version FROM ai_policies WHERE workspace_id = $1 FOR UPDATE", [claims.workspaceId]);
    if (excluded) {
      await client.query(
        "INSERT INTO ai_exclusions (workspace_id, account_id, reason, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT (workspace_id, account_id) DO UPDATE SET reason = EXCLUDED.reason, created_by = EXCLUDED.created_by",
        [claims.workspaceId, accountId, reason ?? null, actorId],
      );
    } else {
      await client.query("DELETE FROM ai_exclusions WHERE workspace_id = $1 AND account_id = $2", [claims.workspaceId, accountId]);
    }
    await client.query("UPDATE ai_policies SET policy_version = policy_version + 1, updated_at = now() WHERE workspace_id = $1", [claims.workspaceId]);
    // Invalidate queued (not yet dispatched) work; dispatched sends are
    // history and cannot be recalled (stated limitation, §538-conformant).
    await client.query("UPDATE ai_dispatch_permits SET status = 'INVALIDATED' WHERE workspace_id = $1 AND status = 'QUEUED'", [claims.workspaceId]);
    const version = await currentVersion(client, claims.workspaceId);
    return { policyVersion: version.toString(10), excludedAccountIds: await excludedIds(client, claims.workspaceId) };
  });
}

export async function getPolicy(pool: Pool, claims: TenantClaims): Promise<PolicyState> {
  return withTenant(pool, claims, async (client) => {
    const version = await currentVersion(client, claims.workspaceId);
    return { policyVersion: version.toString(10), excludedAccountIds: await excludedIds(client, claims.workspaceId) };
  });
}

function checkPurpose(purpose: unknown): string {
  if (typeof purpose !== "string" || purpose.length < 1 || purpose.length > 120) throw new TenantInvalid();
  return purpose;
}

/**
 * Issue a dispatch permit snapshotting currently eligible accounts.
 * Requested ids must all resolve to known workspace accounts (unknown =
 * deny); omitted requested ids mean "all currently eligible".
 */
export async function issuePermit(pool: Pool, claims: TenantClaims, purpose: string, requestedAccountIds?: string[]): Promise<Permit> {
  const cleanPurpose = checkPurpose(purpose);
  return withTenant(pool, claims, async (client) => {
    const known = await client.query("SELECT id FROM accounts WHERE workspace_id = $1", [claims.workspaceId]);
    const knownIds = new Set((known.rows as { id: string }[]).map((r) => r.id));
    const excluded = new Set(await excludedIds(client, claims.workspaceId));
    let eligible: string[];
    if (requestedAccountIds === undefined) {
      eligible = [...knownIds].filter((id) => !excluded.has(id)).sort();
    } else {
      for (const id of requestedAccountIds) {
        if (!isUuid(id) || !knownIds.has(id)) throw new PolicyError("unknown_account");
      }
      eligible = [...requestedAccountIds].filter((id) => !excluded.has(id)).sort();
    }
    const version = await currentVersion(client, claims.workspaceId);
    const id = uuidv7();
    const expires = new Date(Date.now() + PERMIT_TTL_MIN * 60 * 1000).toISOString();
    await client.query(
      "INSERT INTO ai_dispatch_permits (workspace_id, id, policy_version, eligible_account_ids, purpose, status, expires_at) VALUES ($1, $2, $3, $4, $5, 'QUEUED', $6)",
      [claims.workspaceId, id, version.toString(10), JSON.stringify(eligible), cleanPurpose, expires],
    );
    return { workspaceId: claims.workspaceId, id, policyVersion: version.toString(10), eligibleAccountIds: eligible, purpose: cleanPurpose, status: "QUEUED" as const };
  });
}

/** Eligible selection for a permit, with provenance. Exclusions applied before anything else. */
export async function selectEligible(pool: Pool, claims: TenantClaims, permitId: string): Promise<EligibleSelection> {
  if (!isUuid(permitId)) throw new TenantInvalid();
  return withTenant(pool, claims, async (client) => {
    const found = await client.query("SELECT policy_version AS v, eligible_account_ids AS ids, status FROM ai_dispatch_permits WHERE workspace_id = $1 AND id = $2", [
      claims.workspaceId,
      permitId,
    ]);
    if ((found.rowCount ?? 0) === 0) throw new PolicyError("permit_consumed");
    const permit = found.rows[0] as { v: string; ids: string[]; status: string };
    if (permit.status === "INVALIDATED") throw new PolicyError("permit_invalidated");
    if (permit.status !== "QUEUED") throw new PolicyError("permit_consumed");
    const eligible = (permit.ids as string[]).filter((id) => isUuid(id));
    const rows =
      eligible.length === 0
        ? { rows: [] as { workspaceId: string; id: string; name: string }[] }
        : await client.query('SELECT workspace_id AS "workspaceId", id, name FROM accounts WHERE workspace_id = $1 AND id = ANY($2::uuid[]) ORDER BY id', [
            claims.workspaceId,
            eligible,
          ]);
    return {
      accounts: rows.rows as { workspaceId: string; id: string; name: string }[],
      provenance: { policyVersion: String(permit.v), eligibleAccountIds: eligible },
    };
  });
}

export type EligibleSummary = { accountCount: number; coverage: "full" | "partial"; policyVersion: string };

/** Aggregate over eligible accounts only; partial coverage is explicit, never a full-workspace total. */
export async function summarizeEligible(pool: Pool, claims: TenantClaims): Promise<EligibleSummary> {
  return withTenant(pool, claims, async (client) => {
    const version = await currentVersion(client, claims.workspaceId);
    const total = await client.query("SELECT count(*)::int AS n FROM accounts WHERE workspace_id = $1", [claims.workspaceId]);
    const excluded = await client.query("SELECT count(*)::int AS n FROM ai_exclusions WHERE workspace_id = $1", [claims.workspaceId]);
    const totalN = (total.rows[0] as { n: number }).n;
    const excludedN = (excluded.rows[0] as { n: number }).n;
    return { accountCount: totalN - excludedN, coverage: excludedN > 0 ? "partial" : "full", policyVersion: version.toString(10) };
  });
}

/**
 * Consume a permit for one provider dispatch: atomic CAS to DISPATCHED plus
 * revalidation that the workspace policy version is unchanged since issue.
 * Returns the eligible selection for the (fake or real) sender.
 */
export async function consumePermit(pool: Pool, claims: TenantClaims, permitId: string): Promise<EligibleSelection> {
  if (!isUuid(permitId)) throw new TenantInvalid();
  return withTenant(pool, claims, async (client) => {
    const version = await currentVersion(client, claims.workspaceId);
    const updated = await client.query(
      "UPDATE ai_dispatch_permits SET status = 'DISPATCHED' WHERE workspace_id = $1 AND id = $2 AND status = 'QUEUED' AND policy_version = $3 AND expires_at > now() RETURNING policy_version AS v, eligible_account_ids AS ids",
      [claims.workspaceId, permitId, version.toString(10)],
    );
    if ((updated.rowCount ?? 0) === 0) {
      const found = await client.query("SELECT status, policy_version AS v, expires_at AS e FROM ai_dispatch_permits WHERE workspace_id = $1 AND id = $2", [
        claims.workspaceId,
        permitId,
      ]);
      if ((found.rowCount ?? 0) === 0) throw new PolicyError("permit_consumed");
      const row = found.rows[0] as { status: string; v: string; e: string };
      if (row.status === "INVALIDATED") throw new PolicyError("permit_invalidated");
      if (row.status !== "QUEUED") throw new PolicyError("permit_consumed");
      if (new Date(row.e).getTime() <= Date.now()) throw new PolicyError("permit_expired");
      throw new PolicyError("permit_stale"); // version moved since issue
    }
    const permit = updated.rows[0] as { v: string; ids: string[] };
    const eligible = (permit.ids as string[]).filter((id) => isUuid(id));
    const rows =
      eligible.length === 0
        ? { rows: [] as { workspaceId: string; id: string; name: string }[] }
        : await client.query('SELECT workspace_id AS "workspaceId", id, name FROM accounts WHERE workspace_id = $1 AND id = ANY($2::uuid[]) ORDER BY id', [
            claims.workspaceId,
            eligible,
          ]);
    return {
      accounts: rows.rows as { workspaceId: string; id: string; name: string }[],
      provenance: { policyVersion: String(permit.v), eligibleAccountIds: eligible },
    };
  });
}

/** Payload fingerprint over eligible data only (hashes, never values, in logs). */
export function fingerprintEligible(selection: EligibleSelection, purpose: string): string {
  return createHash("sha256").update(JSON.stringify({ purpose, v: selection.provenance.policyVersion, ids: selection.provenance.eligibleAccountIds })).digest("hex");
}

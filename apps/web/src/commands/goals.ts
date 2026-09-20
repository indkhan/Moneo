// E06-S02 goals and virtual fixed-amount allocations commands.
// Allocations reserve spendable cash per (goal, account) without creating
// cash. Concurrent allocations cannot double-reserve; lock order is fixed:
// accounts row → goals row → allocation row. Every mutation is journaled
// with optimistic versions as decimal strings, audit rows, and revision bump.

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isUuid, uuidv7 } from "../ids.ts";
import { formatDecimalBigint, parseDecimalBigint } from "../money.ts";
import { TenantDenied, TenantInvalid, withTenant, type TenantClaims } from "../tenancy.ts";
import { bumpRevision, claimAndExecute, insertAudit, TxError, type TxOutcome } from "./transactions.ts";

export const GOAL_CREATE_COMMAND = "goals.create";
export const GOAL_UPDATE_COMMAND = "goals.update";
export const GOAL_ARCHIVE_COMMAND = "goals.archive";
export const ALLOCATION_ALLOCATE_COMMAND = "allocations.allocate";
export const ALLOCATION_RELEASE_COMMAND = "allocations.release";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const MINOR_RE = /^[0-9]+$/;

function checkUuid(value: unknown): string {
  if (typeof value !== "string" || !isUuid(value)) throw new TenantInvalid();
  return value;
}

function checkVersion(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) throw new TenantInvalid();
  return value;
}

function checkDate(value: unknown): string {
  if (typeof value !== "string" || !DATE_RE.test(value)) throw new TenantInvalid();
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new TenantInvalid();
  return value;
}

function checkCurrency(value: unknown): string {
  if (typeof value !== "string" || !CURRENCY_RE.test(value)) throw new TenantInvalid();
  return value;
}

function checkMinor(value: unknown): string {
  if (typeof value !== "string" || !MINOR_RE.test(value)) throw new TenantInvalid();
  return value.replace(/^0+(?=[0-9])/, "");
}

function unknownKeys(value: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TenantInvalid();
  }
}

export type GoalCreateInput = {
  workspaceId: string;
  name: string;
  goalType: "SAVINGS_TARGET" | "EMERGENCY_FUND" | "PURCHASE" | "TRAVEL" | "DEBT_REDUCTION" | "CUSTOM";
  targetAmountMinor?: string;
  currency?: string;
  targetDate?: string;
  priority?: number;
  idempotencyKey: string;
};

export function validateCreateGoalInput(value: unknown): GoalCreateInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  unknownKeys(v, ["workspaceId", "name", "goalType", "targetAmountMinor", "currency", "targetDate", "priority", "idempotencyKey"]);
  if (typeof v.name !== "string" || v.name.trim().length < 1 || v.name.trim().length > 200) throw new TenantInvalid();
  const goalType = v.goalType;
  if (!["SAVINGS_TARGET", "EMERGENCY_FUND", "PURCHASE", "TRAVEL", "DEBT_REDUCTION", "CUSTOM"].includes(goalType as string)) throw new TenantInvalid();
  let targetAmount: string | undefined;
  let currency: string | undefined;
  if (v.targetAmountMinor !== undefined) {
    targetAmount = checkMinor(v.targetAmountMinor);
    currency = v.currency !== undefined ? checkCurrency(v.currency) : undefined;
    if (!currency) throw new TenantInvalid();
  }
  if (v.currency !== undefined && v.targetAmountMinor === undefined) throw new TenantInvalid();
  let targetDate: string | undefined;
  if (v.targetDate !== undefined) targetDate = checkDate(v.targetDate);
  let priority: number | undefined;
  if (v.priority !== undefined) {
    if (!Number.isInteger(v.priority) || (v.priority as number) < 1 || (v.priority as number) > 5) throw new TenantInvalid();
    priority = v.priority as number;
  }
  return {
    workspaceId: checkUuid(v.workspaceId),
    name: v.name.trim(),
    goalType: goalType as GoalCreateInput["goalType"],
    targetAmountMinor: targetAmount,
    currency,
    targetDate,
    priority,
    idempotencyKey: checkUuid(v.idempotencyKey),
  };
}

export type GoalUpdateInput = {
  workspaceId: string;
  goalId: string;
  expectedVersion: string;
  name?: string;
  targetAmountMinor?: string;
  currency?: string;
  targetDate?: string;
  priority?: number;
  idempotencyKey: string;
};

export function validateUpdateGoalInput(value: unknown): GoalUpdateInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  unknownKeys(v, ["workspaceId", "goalId", "expectedVersion", "name", "targetAmountMinor", "currency", "targetDate", "priority", "idempotencyKey"]);
  let name: string | undefined;
  if (v.name !== undefined) {
    if (typeof v.name !== "string" || v.name.trim().length < 1 || v.name.trim().length > 200) throw new TenantInvalid();
    name = v.name.trim();
  }
  let targetAmount: string | undefined;
  let currency: string | undefined;
  if (v.targetAmountMinor !== undefined) {
    targetAmount = checkMinor(v.targetAmountMinor);
    currency = v.currency !== undefined ? checkCurrency(v.currency) : undefined;
    if (!currency) throw new TenantInvalid();
  }
  if (v.currency !== undefined && v.targetAmountMinor === undefined) throw new TenantInvalid();
  let targetDate: string | undefined;
  if (v.targetDate !== undefined) targetDate = checkDate(v.targetDate);
  let priority: number | undefined;
  if (v.priority !== undefined) {
    if (!Number.isInteger(v.priority) || (v.priority as number) < 1 || (v.priority as number) > 5) throw new TenantInvalid();
    priority = v.priority as number;
  }
  return {
    workspaceId: checkUuid(v.workspaceId),
    goalId: checkUuid(v.goalId),
    expectedVersion: checkVersion(v.expectedVersion),
    name,
    targetAmountMinor: targetAmount,
    currency,
    targetDate,
    priority,
    idempotencyKey: checkUuid(v.idempotencyKey),
  };
}

export type GoalArchiveInput = {
  workspaceId: string;
  goalId: string;
  expectedVersion: string;
  idempotencyKey: string;
};

export function validateArchiveGoalInput(value: unknown): GoalArchiveInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  unknownKeys(v, ["workspaceId", "goalId", "expectedVersion", "idempotencyKey"]);
  return {
    workspaceId: checkUuid(v.workspaceId),
    goalId: checkUuid(v.goalId),
    expectedVersion: checkVersion(v.expectedVersion),
    idempotencyKey: checkUuid(v.idempotencyKey),
  };
}

export type AllocationAllocateInput = {
  workspaceId: string;
  goalId: string;
  accountId: string;
  amountMinor: string;
  currency: string;
  idempotencyKey: string;
};

export function validateAllocateInput(value: unknown): AllocationAllocateInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  unknownKeys(v, ["workspaceId", "goalId", "accountId", "amountMinor", "currency", "idempotencyKey"]);
  return {
    workspaceId: checkUuid(v.workspaceId),
    goalId: checkUuid(v.goalId),
    accountId: checkUuid(v.accountId),
    amountMinor: checkMinor(v.amountMinor),
    currency: checkCurrency(v.currency),
    idempotencyKey: checkUuid(v.idempotencyKey),
  };
}

export type AllocationReleaseInput = {
  workspaceId: string;
  goalId: string;
  accountId: string;
  amountMinor: string;
  idempotencyKey: string;
};

export function validateReleaseInput(value: unknown): AllocationReleaseInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  unknownKeys(v, ["workspaceId", "goalId", "accountId", "amountMinor", "idempotencyKey"]);
  return {
    workspaceId: checkUuid(v.workspaceId),
    goalId: checkUuid(v.goalId),
    accountId: checkUuid(v.accountId),
    amountMinor: checkMinor(v.amountMinor),
    idempotencyKey: checkUuid(v.idempotencyKey),
  };
}

export type GoalView = {
  workspaceId: string;
  id: string;
  name: string;
  goalType: string;
  status: "ACTIVE" | "ARCHIVED";
  targetAmountMinor: string | null;
  currency: string | null;
  targetDate: string | null;
  priority: number | null;
  reservedMinor: string;
  version: string;
  createdAt: string;
  updatedAt: string;
};

export type AllocationView = {
  workspaceId: string;
  id: string;
  goalId: string;
  accountId: string;
  amountMinor: string;
  currency: string;
  version: string;
  goalVersion: string;
  createdAt: string;
  updatedAt: string;
};

function createHashObj(obj: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

function createGoalHash(input: GoalCreateInput): string {
  return createHashObj({ command: GOAL_CREATE_COMMAND, workspaceId: input.workspaceId, name: input.name, goalType: input.goalType, targetAmountMinor: input.targetAmountMinor ?? null, currency: input.currency ?? null, targetDate: input.targetDate ?? null, priority: input.priority ?? null });
}

function updateGoalHash(input: GoalUpdateInput): string {
  return createHashObj({ command: GOAL_UPDATE_COMMAND, workspaceId: input.workspaceId, goalId: input.goalId, expectedVersion: input.expectedVersion, name: input.name ?? null, targetAmountMinor: input.targetAmountMinor ?? null, currency: input.currency ?? null, targetDate: input.targetDate ?? null, priority: input.priority ?? null });
}

function archiveGoalHash(input: GoalArchiveInput): string {
  return createHashObj({ command: GOAL_ARCHIVE_COMMAND, workspaceId: input.workspaceId, goalId: input.goalId, expectedVersion: input.expectedVersion });
}

function allocateHash(input: AllocationAllocateInput): string {
  return createHashObj({ command: ALLOCATION_ALLOCATE_COMMAND, workspaceId: input.workspaceId, goalId: input.goalId, accountId: input.accountId, amountMinor: input.amountMinor, currency: input.currency });
}

function releaseHash(input: AllocationReleaseInput): string {
  return createHashObj({ command: ALLOCATION_RELEASE_COMMAND, workspaceId: input.workspaceId, goalId: input.goalId, accountId: input.accountId, amountMinor: input.amountMinor });
}

async function toGoalView(client: PoolClient, workspaceId: string, goalId: string): Promise<GoalView> {
  const goalRow = await client.query("SELECT * FROM goals WHERE workspace_id = $1 AND id = $2", [workspaceId, goalId]);
  const row = goalRow.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new TxError("not_found");
  const allocSum = await client.query("SELECT COALESCE(SUM(amount_minor), 0)::text AS total FROM goal_allocations WHERE workspace_id = $1 AND goal_id = $2", [workspaceId, goalId]);
  return {
    workspaceId,
    id: String(row.id),
    name: String(row.name),
    goalType: String(row.goal_type),
    status: String(row.status) as "ACTIVE" | "ARCHIVED",
    targetAmountMinor: row.target_amount_minor === null ? null : String(row.target_amount_minor),
    currency: row.currency_code === null ? null : String(row.currency_code),
    targetDate: row.target_date === null ? null : String(row.target_date),
    priority: row.priority === null ? null : Number(row.priority),
    reservedMinor: String(allocSum.rows[0]?.total ?? "0"),
    version: String(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

async function getAccountCurrency(client: PoolClient, workspaceId: string, accountId: string): Promise<string | null> {
  const row = await client.query("SELECT base_currency_code FROM accounts WHERE workspace_id = $1 AND id = $2", [workspaceId, accountId]);
  return row.rows[0] ? String(row.rows[0].base_currency_code) : null;
}

async function getAccountSpendableCapacity(client: PoolClient, workspaceId: string, accountId: string): Promise<bigint> {
  const snap = await client.query(
    `SELECT amount_minor FROM balance_snapshots WHERE workspace_id = $1 AND account_id = $2 AND currency = (SELECT base_currency_code FROM accounts WHERE workspace_id = $1 AND id = $2) AND amount_minor > 0 ORDER BY as_of_date DESC LIMIT 1`,
    [workspaceId, accountId],
  );
  if (snap.rows.length === 0) return 0n;
  return BigInt(String(snap.rows[0].amount_minor));
}

async function getAccountTotalAllocated(client: PoolClient, workspaceId: string, accountId: string): Promise<bigint> {
  const row = await client.query("SELECT COALESCE(SUM(amount_minor), 0)::text AS total FROM goal_allocations WHERE workspace_id = $1 AND account_id = $2", [workspaceId, accountId]);
  return BigInt(String(row.rows[0]?.total ?? "0"));
}

export async function createGoalTx(client: PoolClient, claims: TenantClaims, actorId: string, input: GoalCreateInput): Promise<TxOutcome<GoalView>> {
  return claimAndExecute(client, claims, actorId, GOAL_CREATE_COMMAND, input.idempotencyKey, createGoalHash(input), async (client, operationId) => {
    const id = uuidv7();
    await client.query(
      `INSERT INTO goals (workspace_id, id, name, goal_type, target_amount_minor, currency_code, target_date, priority, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '1')`,
      [claims.workspaceId, id, input.name, input.goalType, input.targetAmountMinor ?? null, input.currency ?? null, input.targetDate ?? null, input.priority ?? null],
    );
    const view = await toGoalView(client, claims.workspaceId, id);
    await insertAudit(client, claims, actorId, "goal", id, "create", null, view, operationId);
    await bumpRevision(client, claims.workspaceId);
    return { view, operationId };
  });
}

export async function updateGoalTx(client: PoolClient, claims: TenantClaims, actorId: string, input: GoalUpdateInput): Promise<TxOutcome<GoalView>> {
  const expected = BigInt(input.expectedVersion);
  return claimAndExecute(client, claims, actorId, GOAL_UPDATE_COMMAND, input.idempotencyKey, updateGoalHash(input), async (client, operationId) => {
    const goal = await client.query("SELECT * FROM goals WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [claims.workspaceId, input.goalId]);
    const row = goal.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new TxError("not_found");
    if (BigInt(String(row.version)) !== expected) throw new TxError("version_mismatch", String(row.version));
    if (String(row.status) === "ARCHIVED") throw new TxError("not_found");
    const updates: string[] = [];
    const params: unknown[] = [claims.workspaceId, input.goalId];
    let idx = 3;
    if (input.name !== undefined) { updates.push(`name = $${idx++}`); params.push(input.name); }
    if (input.targetAmountMinor !== undefined) { updates.push(`target_amount_minor = $${idx++}`); params.push(input.targetAmountMinor); }
    if (input.currency !== undefined) { updates.push(`currency_code = $${idx++}`); params.push(input.currency); }
    if (input.targetDate !== undefined) { updates.push(`target_date = $${idx++}`); params.push(input.targetDate); }
    if (input.priority !== undefined) { updates.push(`priority = $${idx++}`); params.push(input.priority); }
    updates.push(`version = version + 1`);
    updates.push(`updated_at = now()`);
    await client.query(`UPDATE goals SET ${updates.join(", ")} WHERE workspace_id = $1 AND id = $2`, params);
    const view = await toGoalView(client, claims.workspaceId, input.goalId);
    await insertAudit(client, claims, actorId, "goal", input.goalId, "update", { version: String(row.version) }, { version: view.version }, operationId);
    await bumpRevision(client, claims.workspaceId);
    return { view, operationId };
  });
}

export async function archiveGoalTx(client: PoolClient, claims: TenantClaims, actorId: string, input: GoalArchiveInput): Promise<TxOutcome<GoalView>> {
  const expected = BigInt(input.expectedVersion);
  return claimAndExecute(client, claims, actorId, GOAL_ARCHIVE_COMMAND, input.idempotencyKey, archiveGoalHash(input), async (client, operationId) => {
    const goal = await client.query("SELECT * FROM goals WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [claims.workspaceId, input.goalId]);
    const row = goal.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new TxError("not_found");
    if (BigInt(String(row.version)) !== expected) throw new TxError("version_mismatch", String(row.version));
    await client.query("UPDATE goals SET status = 'ARCHIVED', version = version + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, input.goalId]);
    const view = await toGoalView(client, claims.workspaceId, input.goalId);
    await insertAudit(client, claims, actorId, "goal", input.goalId, "archive", { status: String(row.status) }, { status: "ARCHIVED" }, operationId);
    await bumpRevision(client, claims.workspaceId);
    return { view, operationId };
  });
}

export async function allocateTx(client: PoolClient, claims: TenantClaims, actorId: string, input: AllocationAllocateInput): Promise<TxOutcome<AllocationView>> {
  return claimAndExecute(client, claims, actorId, ALLOCATION_ALLOCATE_COMMAND, input.idempotencyKey, allocateHash(input), async (client, operationId) => {
    // Fixed lock order: account → goal → allocation
    const acc = await client.query("SELECT base_currency_code FROM accounts WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [claims.workspaceId, input.accountId]);
    if (acc.rows.length === 0) throw new TxError("not_found");
    const accCurrency = String(acc.rows[0].base_currency_code);
    if (accCurrency !== input.currency) throw new TxError("currency_mismatch", undefined, { accountCurrency: accCurrency });

    const goal = await client.query("SELECT * FROM goals WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [claims.workspaceId, input.goalId]);
    const goalRow = goal.rows[0] as Record<string, unknown> | undefined;
    if (!goalRow) throw new TxError("not_found");
    if (String(goalRow.status) === "ARCHIVED") throw new TxError("goal_archived");

    // Atomic check-and-insert using a CTE to prevent race conditions
    const ask = BigInt(input.amountMinor);
    const alloc = await client.query(
      `WITH caps AS (
         SELECT
           COALESCE((
             SELECT amount_minor FROM balance_snapshots
             WHERE workspace_id = $1 AND account_id = $2
               AND currency = (SELECT base_currency_code FROM accounts WHERE workspace_id = $1 AND id = $2)
               AND amount_minor > 0
             ORDER BY as_of_date DESC LIMIT 1
           ), 0)::text AS capacity,
           COALESCE((
             SELECT SUM(amount_minor)::text FROM goal_allocations
             WHERE workspace_id = $1 AND account_id = $2
           ), '0') AS current_allocated
       ),
       cap_check AS (
         SELECT
           capacity::bigint AS cap,
           current_allocated::bigint AS allocated,
           (capacity::bigint - current_allocated::bigint) AS available
         FROM caps
       )
       INSERT INTO goal_allocations (workspace_id, id, goal_id, account_id, allocation_type, amount_minor, currency_code, version)
       SELECT $1, $4, $3, $2, 'FIXED_AMOUNT', $5, $6, '1'
       FROM cap_check
       WHERE available >= $5
       ON CONFLICT (workspace_id, goal_id, account_id)
       DO UPDATE SET amount_minor = goal_allocations.amount_minor + EXCLUDED.amount_minor, version = goal_allocations.version + 1, updated_at = now()
       WHERE (SELECT available FROM cap_check) >= $5
       RETURNING *`,
      [claims.workspaceId, input.accountId, input.goalId, uuidv7(), input.amountMinor, input.currency],
    );

    if (alloc.rows.length === 0) {
      // Capacity exhausted - compute available for error detail
      const capRow = await client.query(
        `SELECT
           COALESCE((
             SELECT amount_minor FROM balance_snapshots
             WHERE workspace_id = $1 AND account_id = $2
               AND currency = (SELECT base_currency_code FROM accounts WHERE workspace_id = $1 AND id = $2)
               AND amount_minor > 0
             ORDER BY as_of_date DESC LIMIT 1
           ), 0)::text AS capacity,
           COALESCE((
             SELECT SUM(amount_minor)::text FROM goal_allocations
             WHERE workspace_id = $1 AND account_id = $2
           ), '0') AS current_allocated`,
        [claims.workspaceId, input.accountId],
      );
      const capacity = BigInt(String(capRow.rows[0]?.capacity ?? "0"));
      const currentAllocated = BigInt(String(capRow.rows[0]?.current_allocated ?? "0"));
      throw new TxError("overallocation", undefined, { availableMinor: (capacity - currentAllocated).toString() });
    }

    const allocRow = alloc.rows[0] as Record<string, unknown>;
    await client.query("UPDATE goals SET version = version + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, input.goalId]);
    const goalAfter = await client.query("SELECT version FROM goals WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, input.goalId]);
    const goalVersion = String(goalAfter.rows[0]?.version ?? "0");
    const view: AllocationView = {
      workspaceId: claims.workspaceId,
      id: String(allocRow.id),
      goalId: input.goalId,
      accountId: input.accountId,
      amountMinor: String(allocRow.amount_minor),
      currency: input.currency,
      version: String(allocRow.version),
      goalVersion,
      createdAt: String(allocRow.created_at),
      updatedAt: String(allocRow.updated_at),
    };
    const auditAfterState: unknown = { ...view };
    await client.query(
      `INSERT INTO audit_events (workspace_id, id, actor_type, actor_user_id, entity_type, entity_id, action, before_state, after_state, operation_id, compensating_operation_id)
       VALUES ($1, $2, 'user', $3, $4, $5, $6, $7, $8, $9, $10)`,
      [claims.workspaceId, uuidv7(), actorId, "goal_allocation", allocRow.id, "allocate", JSON.stringify(null), JSON.stringify(auditAfterState), operationId, null],
    );
    await bumpRevision(client, claims.workspaceId);
    return { view, operationId };
  });
}

export async function releaseTx(client: PoolClient, claims: TenantClaims, actorId: string, input: AllocationReleaseInput): Promise<TxOutcome<AllocationView>> {
  return claimAndExecute(client, claims, actorId, ALLOCATION_RELEASE_COMMAND, input.idempotencyKey, releaseHash(input), async (client, operationId) => {
    const alloc = await client.query("SELECT * FROM goal_allocations WHERE workspace_id = $1 AND goal_id = $2 AND account_id = $3 FOR UPDATE", [claims.workspaceId, input.goalId, input.accountId]);
    const row = alloc.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new TxError("not_found");
    const current = BigInt(String(row.amount_minor));
    const release = BigInt(input.amountMinor);
    if (release > current) throw new TxError("overallocation", undefined, { availableMinor: current.toString() });
    const next = current - release;
    if (next === 0n) {
      await client.query("DELETE FROM goal_allocations WHERE workspace_id = $1 AND goal_id = $2 AND account_id = $3", [claims.workspaceId, input.goalId, input.accountId]);
      await client.query("UPDATE goals SET version = version + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, input.goalId]);
      const goalAfter = await client.query("SELECT version FROM goals WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, input.goalId]);
      const goalVersion = String(goalAfter.rows[0]?.version ?? "0");
      const view: AllocationView = {
        workspaceId: claims.workspaceId,
        id: String(row.id),
        goalId: input.goalId,
        accountId: input.accountId,
        amountMinor: "0",
        currency: String(row.currency_code),
        version: String(BigInt(String(row.version)) + 1n),
        goalVersion,
        createdAt: String(row.created_at),
        updatedAt: new Date().toISOString(),
      };
      const auditAfterState: unknown = { ...view };
await client.query(
  `INSERT INTO audit_events (workspace_id, id, actor_type, actor_user_id, entity_type, entity_id, action, before_state, after_state, operation_id, compensating_operation_id)
   VALUES ($1, $2, 'user', $3, $4, $5, $6, $7, $8, $9, $10)`,
  [claims.workspaceId, uuidv7(), actorId, "goal_allocation", row.id, "release", JSON.stringify({ amountMinor: String(row.amount_minor) }), JSON.stringify(auditAfterState), operationId, null],
);
      await bumpRevision(client, claims.workspaceId);
      return { view, operationId };
    } else {
      await client.query("UPDATE goal_allocations SET amount_minor = $1, version = version + 1, updated_at = now() WHERE workspace_id = $2 AND goal_id = $3 AND account_id = $4", [next.toString(), claims.workspaceId, input.goalId, input.accountId]);
      await client.query("UPDATE goals SET version = version + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, input.goalId]);
      const goalAfter = await client.query("SELECT version FROM goals WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, input.goalId]);
      const goalVersion = String(goalAfter.rows[0]?.version ?? "0");
      const view: AllocationView = {
        workspaceId: claims.workspaceId,
        id: String(row.id),
        goalId: input.goalId,
        accountId: input.accountId,
        amountMinor: next.toString(),
        currency: String(row.currency_code),
        version: String(BigInt(String(row.version)) + 1n),
        goalVersion,
        createdAt: String(row.created_at),
        updatedAt: new Date().toISOString(),
      };
      const auditAfterState: unknown = { ...view };
await client.query(
  `INSERT INTO audit_events (workspace_id, id, actor_type, actor_user_id, entity_type, entity_id, action, before_state, after_state, operation_id, compensating_operation_id)
   VALUES ($1, $2, 'user', $3, $4, $5, $6, $7, $8, $9, $10)`,
  [claims.workspaceId, uuidv7(), actorId, "goal_allocation", row.id, "release", JSON.stringify({ amountMinor: String(row.amount_minor) }), JSON.stringify(auditAfterState), operationId, null],
);
      await bumpRevision(client, claims.workspaceId);
      return { view, operationId };
    }
  });
}

export type GoalResult = { view: GoalView; operationId: string; replayed: boolean };
export type AllocationResult = { view: AllocationView; operationId: string; replayed: boolean };

function toTxError(outcome: { ok: false; code: TxError["code"]; currentVersion?: string; detail?: unknown }): TxError {
  return new TxError(outcome.code, outcome.currentVersion, outcome.detail);
}

export async function createGoal(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<GoalResult> {
  const input = validateCreateGoalInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => createGoalTx(client, claims, actorId, input));
  if (!outcome.ok) throw toTxError(outcome);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

export async function updateGoal(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<GoalResult> {
  const input = validateUpdateGoalInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => updateGoalTx(client, claims, actorId, input));
  if (!outcome.ok) throw toTxError(outcome);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

export async function archiveGoal(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<GoalResult> {
  const input = validateArchiveGoalInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => archiveGoalTx(client, claims, actorId, input));
  if (!outcome.ok) throw toTxError(outcome);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

export async function allocate(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<AllocationResult> {
  const input = validateAllocateInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => allocateTx(client, claims, actorId, input));
  if (!outcome.ok) throw toTxError(outcome);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

export async function release(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<AllocationResult> {
  const input = validateReleaseInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => releaseTx(client, claims, actorId, input));
  if (!outcome.ok) throw toTxError(outcome);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

export async function listGoals(pool: Pool, claims: TenantClaims, includeArchived = false): Promise<GoalView[]> {
  return withTenant(pool, claims, async (client) => {
    const statusClause = includeArchived ? "" : "AND status = 'ACTIVE'";
    const rows = await client.query(`SELECT * FROM goals WHERE workspace_id = $1 ${statusClause} ORDER BY created_at`, [claims.workspaceId]);
    const out: GoalView[] = [];
    for (const row of rows.rows as Record<string, unknown>[]) {
      const allocSum = await client.query("SELECT COALESCE(SUM(amount_minor), 0)::text AS total FROM goal_allocations WHERE workspace_id = $1 AND goal_id = $2", [claims.workspaceId, String(row.id)]);
      out.push({
        workspaceId: claims.workspaceId,
        id: String(row.id),
        name: String(row.name),
        goalType: String(row.goal_type),
        status: String(row.status) as "ACTIVE" | "ARCHIVED",
        targetAmountMinor: row.target_amount_minor === null ? null : String(row.target_amount_minor),
        currency: row.currency_code === null ? null : String(row.currency_code),
        targetDate: row.target_date === null ? null : String(row.target_date),
        priority: row.priority === null ? null : Number(row.priority),
        reservedMinor: String(allocSum.rows[0]?.total ?? "0"),
        version: String(row.version),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      });
    }
    return out;
  });
}

export async function getGoal(pool: Pool, claims: TenantClaims, goalId: string): Promise<GoalView> {
  return withTenant(pool, claims, async (client) => toGoalView(client, claims.workspaceId, goalId));
}
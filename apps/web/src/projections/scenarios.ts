// E06-S04 flat what-if scenarios as deltas over the baseline model.
// Scenarios store only hypothetical override rows; evaluation reuses the
// shared S03 engine (resolve + compute) with scenario extras, so scenario
// edits never mutate booked transactions and every surface shares one
// calculation. R1 is flat-only: parent links are rejected at the boundary.

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isUuid, uuidv7 } from "../ids.ts";
import { TenantDenied, TenantInvalid, withTenant, type TenantClaims } from "../tenancy.ts";
import { bumpRevision, claimAndExecute, insertAudit, TxError, type TxOutcome } from "../commands/transactions.ts";
import { checkAssumptionValue, type AssumptionType } from "../commands/projection-inputs.ts";
import { evaluateProjection, type ATSView, type ProjectionEvaluation } from "./engine.ts";

export const SCENARIO_CREATE_COMMAND = "scenarios.create";
export const SCENARIO_UPDATE_COMMAND = "scenarios.update";
export const SCENARIO_ARCHIVE_COMMAND = "scenarios.archive";
export const OVERRIDE_ADD_COMMAND = "scenario-overrides.add";
export const OVERRIDE_REMOVE_COMMAND = "scenario-overrides.remove";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const MINOR_RE = /^[0-9]+$/;

export const OVERRIDE_TYPES = [
  "ONE_TIME_EXPENSE",
  "ONE_TIME_INCOME",
  "RECURRING_EXPENSE_CHANGE",
  "INCOME_CHANGE",
  "GOAL_TARGET_CHANGE",
  "GOAL_DATE_CHANGE",
  "ASSUMPTION_OVERRIDE",
] as const;

export type OverrideType = (typeof OVERRIDE_TYPES)[number];

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

function checkDayOfMonth(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 31) throw new TenantInvalid();
  return value as number;
}

function unknownKeys(value: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TenantInvalid();
  }
}

export type ScenarioView = {
  workspaceId: string;
  id: string;
  name: string;
  status: "ACTIVE" | "ARCHIVED";
  version: string;
  createdAt: string;
  updatedAt: string;
};

export type OverrideView = {
  workspaceId: string;
  id: string;
  scenarioId: string;
  overrideType: OverrideType;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  payload: Record<string, unknown>;
  version: string;
  createdAt: string;
};

export type CreateScenarioInput = { workspaceId: string; name: string; idempotencyKey: string };

export function validateCreateScenarioInput(value: unknown): CreateScenarioInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  unknownKeys(v, ["workspaceId", "name", "idempotencyKey"]);
  if (typeof v.name !== "string" || v.name.trim().length < 1 || v.name.trim().length > 200) throw new TenantInvalid();
  return { workspaceId: checkUuid(v.workspaceId), name: (v.name as string).trim(), idempotencyKey: checkUuid(v.idempotencyKey) };
}

export type UpdateScenarioInput = { workspaceId: string; scenarioId: string; expectedVersion: string; name: string; idempotencyKey: string };

export function validateUpdateScenarioInput(value: unknown): UpdateScenarioInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  unknownKeys(v, ["workspaceId", "scenarioId", "expectedVersion", "name", "idempotencyKey"]);
  if (typeof v.name !== "string" || v.name.trim().length < 1 || v.name.trim().length > 200) throw new TenantInvalid();
  return { workspaceId: checkUuid(v.workspaceId), scenarioId: checkUuid(v.scenarioId), expectedVersion: checkVersion(v.expectedVersion), name: (v.name as string).trim(), idempotencyKey: checkUuid(v.idempotencyKey) };
}

export type ArchiveScenarioInput = { workspaceId: string; scenarioId: string; expectedVersion: string; idempotencyKey: string };

export function validateArchiveScenarioInput(value: unknown): ArchiveScenarioInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  unknownKeys(v, ["workspaceId", "scenarioId", "expectedVersion", "idempotencyKey"]);
  return { workspaceId: checkUuid(v.workspaceId), scenarioId: checkUuid(v.scenarioId), expectedVersion: checkVersion(v.expectedVersion), idempotencyKey: checkUuid(v.idempotencyKey) };
}

export type AddOverrideInput = {
  workspaceId: string;
  scenarioId: string;
  overrideType: OverrideType;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  payload: Record<string, unknown>;
  idempotencyKey: string;
};

function checkOverridePayload(type: OverrideType, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  switch (type) {
    case "ONE_TIME_EXPENSE":
    case "ONE_TIME_INCOME": {
      unknownKeys(v, ["amountMinor", "currency", "date", "accountId", "toAccountId", "description"]);
      const out: Record<string, unknown> = { amountMinor: checkMinor(v.amountMinor), currency: checkCurrency(v.currency), date: checkDate(v.date) };
      if (v.accountId !== undefined) out.accountId = checkUuid(v.accountId);
      if (v.toAccountId !== undefined) out.toAccountId = checkUuid(v.toAccountId);
      if (v.description !== undefined) {
        if (typeof v.description !== "string" || v.description.length < 1 || v.description.length > 200) throw new TenantInvalid();
        out.description = v.description;
      }
      return out;
    }
    case "RECURRING_EXPENSE_CHANGE":
    case "INCOME_CHANGE": {
      unknownKeys(v, ["amountMinor", "currency", "dayOfMonth", "direction", "accountId"]);
      const out: Record<string, unknown> = { amountMinor: checkMinor(v.amountMinor), currency: checkCurrency(v.currency), dayOfMonth: checkDayOfMonth(v.dayOfMonth) };
      if (v.direction !== undefined) {
        if (v.direction !== "INFLOW" && v.direction !== "OUTFLOW") throw new TenantInvalid();
        out.direction = v.direction;
      }
      if (v.accountId !== undefined) out.accountId = checkUuid(v.accountId);
      return out;
    }
    case "GOAL_TARGET_CHANGE": {
      unknownKeys(v, ["goalId", "targetAmountMinor", "currency"]);
      return { goalId: checkUuid(v.goalId), targetAmountMinor: checkMinor(v.targetAmountMinor), currency: checkCurrency(v.currency) };
    }
    case "GOAL_DATE_CHANGE": {
      unknownKeys(v, ["goalId", "targetDate"]);
      return { goalId: checkUuid(v.goalId), targetDate: checkDate(v.targetDate) };
    }
    case "ASSUMPTION_OVERRIDE": {
      unknownKeys(v, ["assumptionId", "value"]);
      return { assumptionId: checkUuid(v.assumptionId), value: v.value as Record<string, unknown> };
    }
  }
}

export function validateAddOverrideInput(value: unknown): AddOverrideInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  unknownKeys(v, ["workspaceId", "scenarioId", "overrideType", "effectiveFrom", "effectiveTo", "payload", "idempotencyKey"]);
  if (typeof v.overrideType !== "string" || !(OVERRIDE_TYPES as readonly string[]).includes(v.overrideType)) throw new TenantInvalid();
  let from: string | null = null;
  let to: string | null = null;
  if (v.effectiveFrom !== undefined && v.effectiveFrom !== null) from = checkDate(v.effectiveFrom);
  if (v.effectiveTo !== undefined && v.effectiveTo !== null) {
    to = checkDate(v.effectiveTo);
    if (from !== null && to < from) throw new TenantInvalid();
  }
  return {
    workspaceId: checkUuid(v.workspaceId),
    scenarioId: checkUuid(v.scenarioId),
    overrideType: v.overrideType as OverrideType,
    effectiveFrom: from,
    effectiveTo: to,
    payload: checkOverridePayload(v.overrideType as OverrideType, v.payload),
    idempotencyKey: checkUuid(v.idempotencyKey),
  };
}

export type RemoveOverrideInput = { workspaceId: string; scenarioId: string; overrideId: string; idempotencyKey: string };

export function validateRemoveOverrideInput(value: unknown): RemoveOverrideInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  unknownKeys(v, ["workspaceId", "scenarioId", "overrideId", "idempotencyKey"]);
  return { workspaceId: checkUuid(v.workspaceId), scenarioId: checkUuid(v.scenarioId), overrideId: checkUuid(v.overrideId), idempotencyKey: checkUuid(v.idempotencyKey) };
}

function hash(obj: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

function toScenarioView(ws: string, row: Record<string, unknown>): ScenarioView {
  return {
    workspaceId: ws,
    id: String(row.id),
    name: String(row.name),
    status: String(row.status) as "ACTIVE" | "ARCHIVED",
    version: String(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toOverrideView(ws: string, row: Record<string, unknown>): OverrideView {
  return {
    workspaceId: ws,
    id: String(row.id),
    scenarioId: String(row.scenario_id),
    overrideType: String(row.override_type) as OverrideType,
    effectiveFrom: row.effective_from === null ? null : String(row.effective_from).slice(0, 10),
    effectiveTo: row.effective_to === null ? null : String(row.effective_to).slice(0, 10),
    payload: row.payload as Record<string, unknown>,
    version: String(row.version),
    createdAt: String(row.created_at),
  };
}

async function requireActiveScenario(client: PoolClient, ws: string, scenarioId: string, lock: boolean): Promise<Record<string, unknown>> {
  const row = await client.query(
    `SELECT * FROM scenarios WHERE workspace_id = $1 AND id = $2 ${lock ? "FOR UPDATE" : ""}`,
    [ws, scenarioId],
  );
  const found = row.rows[0] as Record<string, unknown> | undefined;
  if (!found) throw new TxError("not_found");
  if (String(found.status) !== "ACTIVE") throw new TxError("not_found");
  if (found.parent_scenario_id !== null) throw new TxError("not_found");
  return found;
}

export async function createScenarioTx(client: PoolClient, claims: TenantClaims, actorId: string, input: CreateScenarioInput): Promise<TxOutcome<ScenarioView>> {
  return claimAndExecute(client, claims, actorId, SCENARIO_CREATE_COMMAND, input.idempotencyKey, hash({ command: SCENARIO_CREATE_COMMAND, workspaceId: input.workspaceId, name: input.name }), async (client, operationId) => {
    const id = uuidv7();
    await client.query("INSERT INTO scenarios (workspace_id, id, name, status, parent_scenario_id, version) VALUES ($1, $2, $3, 'ACTIVE', NULL, '1')", [claims.workspaceId, id, input.name]);
    const view = await readScenario(client, claims.workspaceId, id);
    await insertAudit(client, claims, actorId, "scenario", id, "create", null, view, operationId);
    await bumpRevision(client, claims.workspaceId);
    return { view, operationId };
  });
}

async function readScenario(client: PoolClient, ws: string, id: string): Promise<ScenarioView> {
  const row = await client.query("SELECT * FROM scenarios WHERE workspace_id = $1 AND id = $2", [ws, id]);
  const found = row.rows[0] as Record<string, unknown> | undefined;
  if (!found) throw new TxError("not_found");
  return toScenarioView(ws, found);
}

export async function updateScenarioTx(client: PoolClient, claims: TenantClaims, actorId: string, input: UpdateScenarioInput): Promise<TxOutcome<ScenarioView>> {
  const expected = BigInt(input.expectedVersion);
  return claimAndExecute(client, claims, actorId, SCENARIO_UPDATE_COMMAND, input.idempotencyKey, hash({ command: SCENARIO_UPDATE_COMMAND, workspaceId: input.workspaceId, scenarioId: input.scenarioId, expectedVersion: input.expectedVersion, name: input.name }), async (client, operationId) => {
    const current = await requireActiveScenario(client, claims.workspaceId, input.scenarioId, true);
    if (BigInt(String(current.version)) !== expected) throw new TxError("version_mismatch", String(current.version));
    await client.query("UPDATE scenarios SET name = $1, version = version + 1, updated_at = now() WHERE workspace_id = $2 AND id = $3", [input.name, claims.workspaceId, input.scenarioId]);
    const view = await readScenario(client, claims.workspaceId, input.scenarioId);
    await insertAudit(client, claims, actorId, "scenario", input.scenarioId, "update", { version: String(current.version) }, { version: view.version }, operationId);
    await bumpRevision(client, claims.workspaceId);
    return { view, operationId };
  });
}

export async function archiveScenarioTx(client: PoolClient, claims: TenantClaims, actorId: string, input: ArchiveScenarioInput): Promise<TxOutcome<ScenarioView>> {
  const expected = BigInt(input.expectedVersion);
  return claimAndExecute(client, claims, actorId, SCENARIO_ARCHIVE_COMMAND, input.idempotencyKey, hash({ command: SCENARIO_ARCHIVE_COMMAND, workspaceId: input.workspaceId, scenarioId: input.scenarioId, expectedVersion: input.expectedVersion }), async (client, operationId) => {
    const current = await requireActiveScenario(client, claims.workspaceId, input.scenarioId, true);
    if (BigInt(String(current.version)) !== expected) throw new TxError("version_mismatch", String(current.version));
    await client.query("UPDATE scenarios SET status = 'ARCHIVED', version = version + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, input.scenarioId]);
    const view = await readScenario(client, claims.workspaceId, input.scenarioId);
    await insertAudit(client, claims, actorId, "scenario", input.scenarioId, "archive", { status: "ACTIVE" }, { status: "ARCHIVED" }, operationId);
    await bumpRevision(client, claims.workspaceId);
    return { view, operationId };
  });
}

export async function addOverrideTx(client: PoolClient, claims: TenantClaims, actorId: string, input: AddOverrideInput): Promise<TxOutcome<OverrideView>> {
  return claimAndExecute(client, claims, actorId, OVERRIDE_ADD_COMMAND, input.idempotencyKey, hash({ command: OVERRIDE_ADD_COMMAND, workspaceId: input.workspaceId, scenarioId: input.scenarioId, overrideType: input.overrideType, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo, payload: input.payload }), async (client, operationId) => {
    const scenario = await requireActiveScenario(client, claims.workspaceId, input.scenarioId, true);
    // Cross-reference liveness: goal and assumption targets must exist and be usable.
    if (input.overrideType === "GOAL_TARGET_CHANGE" || input.overrideType === "GOAL_DATE_CHANGE") {
      const goalId = String((input.payload as Record<string, unknown>).goalId);
      const goal = await client.query("SELECT status FROM goals WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, goalId]);
      if ((goal.rowCount ?? 0) === 0) throw new TxError("not_found");
      if (String((goal.rows[0] as { status: string }).status) !== "ACTIVE") throw new TxError("not_found");
    }
    if (input.overrideType === "ASSUMPTION_OVERRIDE") {
      const targetId = String((input.payload as Record<string, unknown>).assumptionId);
      const target = await client.query("SELECT assumption_type, status FROM financial_assumptions WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, targetId]);
      if ((target.rowCount ?? 0) === 0) throw new TxError("not_found");
      const trow = target.rows[0] as { assumption_type: string; status: string };
      if (trow.status !== "ACTIVE") throw new TxError("not_found");
      // The replacement value must satisfy the target row's own type contract.
      checkAssumptionValue(trow.assumption_type as AssumptionType, (input.payload as Record<string, unknown>).value);
    }
    if ((input.payload as Record<string, unknown>).accountId !== undefined) {
      const acct = await client.query("SELECT 1 FROM accounts WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, String((input.payload as Record<string, unknown>).accountId)]);
      if ((acct.rowCount ?? 0) === 0) throw new TxError("not_found");
    }
    if ((input.payload as Record<string, unknown>).toAccountId !== undefined) {
      const acct = await client.query("SELECT 1 FROM accounts WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, String((input.payload as Record<string, unknown>).toAccountId)]);
      if ((acct.rowCount ?? 0) === 0) throw new TxError("not_found");
    }
    const id = uuidv7();
    await client.query(
      "INSERT INTO scenario_overrides (workspace_id, id, scenario_id, override_type, effective_from, effective_to, payload, version) VALUES ($1, $2, $3, $4, $5, $6, $7, '1')",
      [claims.workspaceId, id, input.scenarioId, input.overrideType, input.effectiveFrom, input.effectiveTo, JSON.stringify(input.payload)],
    );
    await client.query("UPDATE scenarios SET version = version + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, input.scenarioId]);
    const found = await client.query("SELECT * FROM scenario_overrides WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, id]);
    const view = toOverrideView(claims.workspaceId, found.rows[0] as Record<string, unknown>);
    await insertAudit(client, claims, actorId, "scenario_override", id, "create", { scenarioVersion: String(scenario.version) }, view, operationId);
    await bumpRevision(client, claims.workspaceId);
    return { view, operationId };
  });
}

export async function removeOverrideTx(client: PoolClient, claims: TenantClaims, actorId: string, input: RemoveOverrideInput): Promise<TxOutcome<{ removedId: string }>> {
  return claimAndExecute(client, claims, actorId, OVERRIDE_REMOVE_COMMAND, input.idempotencyKey, hash({ command: OVERRIDE_REMOVE_COMMAND, workspaceId: input.workspaceId, scenarioId: input.scenarioId, overrideId: input.overrideId }), async (client, operationId) => {
    const scenario = await requireActiveScenario(client, claims.workspaceId, input.scenarioId, true);
    const found = await client.query("SELECT id FROM scenario_overrides WHERE workspace_id = $1 AND id = $2 AND scenario_id = $3", [claims.workspaceId, input.overrideId, input.scenarioId]);
    if ((found.rowCount ?? 0) === 0) throw new TxError("not_found");
    await client.query("DELETE FROM scenario_overrides WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, input.overrideId]);
    await client.query("UPDATE scenarios SET version = version + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, input.scenarioId]);
    await insertAudit(client, claims, actorId, "scenario_override", input.overrideId, "remove", { scenarioVersion: String(scenario.version) }, { removedId: input.overrideId }, operationId);
    await bumpRevision(client, claims.workspaceId);
    return { view: { removedId: input.overrideId }, operationId };
  });
}

function toTxError(outcome: { ok: false; code: TxError["code"]; currentVersion?: string; detail?: unknown }): TxError {
  return new TxError(outcome.code, outcome.currentVersion, outcome.detail);
}

export type ScenarioResult = { view: ScenarioView; operationId: string; replayed: boolean };
export type OverrideResult = { view: OverrideView; operationId: string; replayed: boolean };

export async function createScenario(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<ScenarioResult> {
  const input = validateCreateScenarioInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => createScenarioTx(client, claims, actorId, input));
  if (!outcome.ok) throw toTxError(outcome);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

export async function updateScenario(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<ScenarioResult> {
  const input = validateUpdateScenarioInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => updateScenarioTx(client, claims, actorId, input));
  if (!outcome.ok) throw toTxError(outcome);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

export async function archiveScenario(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<ScenarioResult> {
  const input = validateArchiveScenarioInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => archiveScenarioTx(client, claims, actorId, input));
  if (!outcome.ok) throw toTxError(outcome);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

export async function addOverride(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<OverrideResult> {
  const input = validateAddOverrideInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => addOverrideTx(client, claims, actorId, input));
  if (!outcome.ok) throw toTxError(outcome);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

export async function removeOverride(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<{ view: { removedId: string }; operationId: string; replayed: boolean }> {
  const input = validateRemoveOverrideInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => removeOverrideTx(client, claims, actorId, input));
  if (!outcome.ok) throw toTxError(outcome);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

export async function listScenarios(pool: Pool, claims: TenantClaims, includeArchived = false): Promise<ScenarioView[]> {
  return withTenant(pool, claims, async (client) => {
    const rows = await client.query(
      `SELECT * FROM scenarios WHERE workspace_id = $1 ${includeArchived ? "" : "AND status = 'ACTIVE'"} ORDER BY created_at`,
      [claims.workspaceId],
    );
    return (rows.rows as Record<string, unknown>[]).map((r) => toScenarioView(claims.workspaceId, r));
  });
}

export async function getScenario(pool: Pool, claims: TenantClaims, scenarioId: string): Promise<{ scenario: ScenarioView; overrides: OverrideView[] }> {
  if (!isUuid(scenarioId)) throw new TenantInvalid();
  return withTenant(pool, claims, async (client) => {
    const scenario = await readScenario(client, claims.workspaceId, scenarioId);
    const rows = await client.query("SELECT * FROM scenario_overrides WHERE workspace_id = $1 AND scenario_id = $2 ORDER BY created_at, id", [claims.workspaceId, scenarioId]);
    return { scenario, overrides: (rows.rows as Record<string, unknown>[]).map((r) => toOverrideView(claims.workspaceId, r)) };
  });
}

export type ScenarioDelta = { caseName: "EXPECTED" | "CONSERVATIVE" | "OPTIMISTIC"; scope: string; pointDate: string; baselineMinor: string; scenarioMinor: string; deltaMinor: string; currency: string };

export type ScenarioCompare = {
  baselineInputHash: string;
  scenarioInputHash: string;
  horizonStart: string;
  horizonDays: number;
  baseCurrency: string;
  baselineAts: ATSView;
  scenarioAts: ATSView;
  goalDisplay: { goalId: string; targetAmountMinor?: string; targetDate?: string }[];
  deltas: ScenarioDelta[];
  baselinePoints: { caseName: string; scope: string; pointDate: string; amountMinor: string; currency: string }[];
  scenarioPoints: { caseName: string; scope: string; pointDate: string; amountMinor: string; currency: string }[];
  aggregated: "daily" | "weekly";
  truncated: boolean;
};

// Compare-payload bounds (story limits): long horizons aggregate to exact
// weekly samples; arrays cap with an explicit truncated flag. 365 d × 3
// cases × N scopes × 2 series must never become an unbounded payload.
const COMPARE_MAX_ROWS = 2000;

/**
 * Compare baseline vs scenario over the same horizon using the shared
 * read-only evaluation (no persisted runs, no booked writes). Deltas are
 * exact minor-unit differences per case/scope/day.
 */
export async function compareScenarios(
  pool: Pool,
  claims: TenantClaims,
  input: { workspaceId: string; scenarioId: string; horizonDays?: number; spendingAccountId?: string; eligibleAccountIds?: string[] },
): Promise<ScenarioCompare> {
  if (typeof input.workspaceId !== "string" || !isUuid(input.workspaceId)) throw new TenantInvalid();
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  if (typeof input.scenarioId !== "string" || !isUuid(input.scenarioId)) throw new TenantInvalid();
  if (input.horizonDays !== undefined && (!Number.isInteger(input.horizonDays) || input.horizonDays < 1 || input.horizonDays > 365)) throw new TenantInvalid();
  if (input.spendingAccountId !== undefined && !isUuid(input.spendingAccountId)) throw new TenantInvalid();
  if (input.eligibleAccountIds !== undefined) {
    if (!Array.isArray(input.eligibleAccountIds) || input.eligibleAccountIds.some((id) => typeof id !== "string" || !isUuid(id))) throw new TenantInvalid();
  }
  const baseline = await evaluateProjection(pool, claims, { horizonDays: input.horizonDays, spendingAccountId: input.spendingAccountId, eligibleAccountIds: input.eligibleAccountIds });
  const scenario = await evaluateProjection(pool, claims, { horizonDays: input.horizonDays, spendingAccountId: input.spendingAccountId, scenarioId: input.scenarioId, eligibleAccountIds: input.eligibleAccountIds });
  const baseByKey = new Map(baseline.points.map((p) => [`${p.caseName}|${p.scope}|${p.pointDate}`, p]));
  const deltas: ScenarioDelta[] = [];
  for (const sp of scenario.points) {
    const bp = baseByKey.get(`${sp.caseName}|${sp.scope}|${sp.pointDate}`);
    if (!bp) continue;
    const delta = BigInt(sp.amountMinor) - BigInt(bp.amountMinor);
    if (delta !== 0n) {
      deltas.push({ caseName: sp.caseName, scope: sp.scope, pointDate: sp.pointDate, baselineMinor: bp.amountMinor, scenarioMinor: sp.amountMinor, deltaMinor: delta.toString(), currency: sp.currencyCode });
    }
  }
  deltas.sort((a, b) => (a.pointDate < b.pointDate ? -1 : a.pointDate > b.pointDate ? 1 : a.caseName < b.caseName ? -1 : 1));
  const goalDisplay = ((scenario.coverage as { scenarioGoalDisplay?: { goalId: string; targetAmountMinor?: string; targetDate?: string }[] }).scenarioGoalDisplay ?? []) as { goalId: string; targetAmountMinor?: string; targetDate?: string }[];
  const snake = (ps: { caseName: string; scope: string; pointDate: string; amountMinor: string; currencyCode: string }[]) =>
    ps.map((p) => ({ caseName: p.caseName, scope: p.scope, pointDate: p.pointDate, amountMinor: p.amountMinor, currency: p.currencyCode }));
  // Long horizons aggregate to exact weekly samples (every 7th day plus the
  // horizon end, exact values — balances are levels, never summed).
  const aggregated: "daily" | "weekly" = scenario.horizonDays > 120 ? "weekly" : "daily";
  const endDate = (() => {
    const t = new Date(`${scenario.horizonStart}T00:00:00Z`).getTime() + (scenario.horizonDays - 1) * 86400000;
    return new Date(t).toISOString().slice(0, 10);
  })();
  const sample = <T extends { pointDate: string }>(rows: T[]): T[] =>
    aggregated === "daily" ? rows : rows.filter((r) => {
      const day = Math.round((new Date(`${r.pointDate}T00:00:00Z`).getTime() - new Date(`${scenario.horizonStart}T00:00:00Z`).getTime()) / 86400000);
      return day % 7 === 6 || r.pointDate === endDate;
    });
  const sampledDeltas = sample(deltas);
  const sampledBaseline = sample(snake(baseline.points));
  const sampledScenario = sample(snake(scenario.points));
  const truncated = sampledDeltas.length > COMPARE_MAX_ROWS || sampledBaseline.length > COMPARE_MAX_ROWS || sampledScenario.length > COMPARE_MAX_ROWS;
  return {
    baselineInputHash: baseline.inputHash,
    scenarioInputHash: scenario.inputHash,
    horizonStart: scenario.horizonStart,
    horizonDays: scenario.horizonDays,
    baseCurrency: scenario.baseCurrency,
    baselineAts: baseline.ats,
    scenarioAts: scenario.ats,
    goalDisplay,
    deltas: sampledDeltas.slice(0, COMPARE_MAX_ROWS),
    baselinePoints: sampledBaseline.slice(0, COMPARE_MAX_ROWS),
    scenarioPoints: sampledScenario.slice(0, COMPARE_MAX_ROWS),
    aggregated,
    truncated,
  };
}

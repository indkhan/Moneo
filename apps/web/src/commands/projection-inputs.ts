// E06-S01 projection settings + financial assumption commands. Settings are
// a single versioned row per workspace; assumptions are append-only rows
// where a new ACTIVE row supersedes the same-type/scope predecessor in the
// same transaction (history is never mutated). Every mutation runs in one
// tenant transaction via the shared command journal with optimistic
// versions as decimal strings, audit rows and a workspace revision bump.

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isUuid, uuidv7 } from "../ids.ts";
import { TenantDenied, TenantInvalid, withTenant, type TenantClaims } from "../tenancy.ts";
import { bumpRevision, claimAndExecute, insertAudit, TxError, type TxOutcome } from "./transactions.ts";
import { getProjectionSettings, listAssumptions, type AssumptionView, type ProjectionSettingsView } from "../projections/inputs.ts";

export const SETTINGS_UPDATE_COMMAND = "projection.settings.update";
export const ASSUMPTION_SET_COMMAND = "assumptions.set";
export const ASSUMPTION_ARCHIVE_COMMAND = "assumptions.archive";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const MINOR_RE = /^[0-9]+$/;
const FP_RE = /^[a-f0-9]{64}$/;

const ASSUMPTION_TYPES = [
  "EXPECTED_INCOME",
  "EXPECTED_VARIABLE_SPEND",
  "EXPECTED_RECURRING_AMOUNT",
  "ONE_TIME_EXPECTED_EXPENSE",
  "ACCOUNT_BEHAVIOR",
  "CUSTOM",
] as const;

type AssumptionType = (typeof ASSUMPTION_TYPES)[number];

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

function checkDayOfMonth(value: unknown, max: number): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) throw new TenantInvalid();
  return value as number;
}

function unknownKeys(value: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TenantInvalid();
  }
}

export type SettingsUpdateInput = {
  workspaceId: string;
  expectedVersion: string;
  horizonDays?: number;
  baselineWeeks?: number;
  safetyFloorMinor?: string;
  savingsIncluded?: boolean;
  idempotencyKey: string;
};

export function validateSettingsUpdateInput(value: unknown): SettingsUpdateInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  unknownKeys(v, ["workspaceId", "expectedVersion", "horizonDays", "baselineWeeks", "safetyFloorMinor", "savingsIncluded", "idempotencyKey"]);
  const out: SettingsUpdateInput = {
    workspaceId: checkUuid(v.workspaceId),
    expectedVersion: checkVersion(v.expectedVersion),
    idempotencyKey: checkUuid(v.idempotencyKey),
  };
  if (v.horizonDays !== undefined) {
    if (!Number.isInteger(v.horizonDays) || (v.horizonDays as number) < 1 || (v.horizonDays as number) > 730) throw new TenantInvalid();
    out.horizonDays = v.horizonDays as number;
  }
  if (v.baselineWeeks !== undefined) {
    if (!Number.isInteger(v.baselineWeeks) || (v.baselineWeeks as number) < 1 || (v.baselineWeeks as number) > 52) throw new TenantInvalid();
    out.baselineWeeks = v.baselineWeeks as number;
  }
  if (v.safetyFloorMinor !== undefined) out.safetyFloorMinor = checkMinor(v.safetyFloorMinor);
  if (v.savingsIncluded !== undefined) {
    if (typeof v.savingsIncluded !== "boolean") throw new TenantInvalid();
    out.savingsIncluded = v.savingsIncluded;
  }
  return out;
}

export type AssumptionValue = Record<string, unknown>;

export type SetAssumptionInput = {
  workspaceId: string;
  assumptionType: AssumptionType;
  validFrom: string;
  validTo: string | null;
  value: AssumptionValue;
  origin: "USER" | "INFERRED" | "SYSTEM" | "IMPORTED";
  confidence: string | null;
  idempotencyKey: string;
};

function checkOrigin(value: unknown): SetAssumptionInput["origin"] {
  if (value === undefined) return "USER";
  if (value === "USER" || value === "INFERRED" || value === "SYSTEM" || value === "IMPORTED") return value;
  throw new TenantInvalid();
}

function checkConfidence(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^(0(\.\d+)?|1(\.0+)?)$/.test(value)) throw new TenantInvalid();
  return value;
}

function checkAssumptionValue(type: AssumptionType, value: unknown): AssumptionValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  switch (type) {
    case "EXPECTED_INCOME": {
      unknownKeys(v, ["amountMinor", "currency", "cadence", "dayOfMonth", "date", "accountId"]);
      if (v.cadence !== "MONTHLY" && v.cadence !== "WEEKLY" && v.cadence !== "ONE_TIME") throw new TenantInvalid();
      const out: AssumptionValue = { amountMinor: checkMinor(v.amountMinor), currency: checkCurrency(v.currency), cadence: v.cadence };
      if (v.cadence === "MONTHLY") out.dayOfMonth = checkDayOfMonth(v.dayOfMonth, 31);
      if (v.cadence === "ONE_TIME") out.date = checkDate(v.date);
      if (v.accountId !== undefined) out.accountId = checkUuid(v.accountId);
      return out;
    }
    case "EXPECTED_VARIABLE_SPEND": {
      unknownKeys(v, ["amountMinor", "currency"]);
      return { amountMinor: checkMinor(v.amountMinor), currency: checkCurrency(v.currency) };
    }
    case "EXPECTED_RECURRING_AMOUNT": {
      unknownKeys(v, ["amountMinor", "currency", "fingerprint"]);
      const out: AssumptionValue = { amountMinor: checkMinor(v.amountMinor), currency: checkCurrency(v.currency) };
      if (v.fingerprint !== undefined) {
        if (typeof v.fingerprint !== "string" || !FP_RE.test(v.fingerprint)) throw new TenantInvalid();
        out.fingerprint = v.fingerprint;
      }
      return out;
    }
    case "ONE_TIME_EXPECTED_EXPENSE": {
      unknownKeys(v, ["amountMinor", "currency", "direction", "date", "accountId", "description"]);
      if (v.direction !== "INFLOW" && v.direction !== "OUTFLOW") throw new TenantInvalid();
      const out: AssumptionValue = {
        amountMinor: checkMinor(v.amountMinor),
        currency: checkCurrency(v.currency),
        direction: v.direction,
        date: checkDate(v.date),
      };
      if (v.accountId !== undefined) out.accountId = checkUuid(v.accountId);
      if (v.description !== undefined) {
        if (typeof v.description !== "string" || v.description.length < 1 || v.description.length > 200) throw new TenantInvalid();
        out.description = v.description;
      }
      return out;
    }
    case "ACCOUNT_BEHAVIOR": {
      unknownKeys(v, ["accountId", "spendable"]);
      if (typeof v.spendable !== "boolean") throw new TenantInvalid();
      return { accountId: checkUuid(v.accountId), spendable: v.spendable };
    }
    case "CUSTOM": {
      unknownKeys(v, ["note"]);
      if (typeof v.note !== "string" || v.note.length < 1 || v.note.length > 500) throw new TenantInvalid();
      return { note: v.note };
    }
  }
}

export function validateSetAssumptionInput(value: unknown): SetAssumptionInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  unknownKeys(v, ["workspaceId", "assumptionType", "validFrom", "validTo", "value", "origin", "confidence", "idempotencyKey"]);
  if (typeof v.assumptionType !== "string" || !(ASSUMPTION_TYPES as readonly string[]).includes(v.assumptionType)) throw new TenantInvalid();
  const type = v.assumptionType as AssumptionType;
  const validFrom = checkDate(v.validFrom);
  let validTo: string | null = null;
  if (v.validTo !== undefined && v.validTo !== null) {
    validTo = checkDate(v.validTo);
    if (validTo < validFrom) throw new TenantInvalid();
  }
  const checked = checkAssumptionValue(type, v.value);
  if (JSON.stringify(checked).length > 4096) throw new TenantInvalid();
  return {
    workspaceId: checkUuid(v.workspaceId),
    assumptionType: type,
    validFrom,
    validTo,
    value: checked,
    origin: checkOrigin(v.origin),
    confidence: checkConfidence(v.confidence),
    idempotencyKey: checkUuid(v.idempotencyKey),
  };
}

export type ArchiveAssumptionInput = {
  workspaceId: string;
  assumptionId: string;
  expectedVersion: string;
  idempotencyKey: string;
};

export function validateArchiveAssumptionInput(value: unknown): ArchiveAssumptionInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  unknownKeys(v, ["workspaceId", "assumptionId", "expectedVersion", "idempotencyKey"]);
  return {
    workspaceId: checkUuid(v.workspaceId),
    assumptionId: checkUuid(v.assumptionId),
    expectedVersion: checkVersion(v.expectedVersion),
    idempotencyKey: checkUuid(v.idempotencyKey),
  };
}

function scopeKeyFor(type: AssumptionType, value: AssumptionValue, freshId: string): string {
  switch (type) {
    case "EXPECTED_INCOME":
      return `income:${String(value.currency)}:${String(value.cadence)}:${String(value.dayOfMonth ?? value.date ?? "any")}:${String(value.accountId ?? "any")}`;
    case "EXPECTED_VARIABLE_SPEND":
      return `varspend:${String(value.currency)}`;
    case "EXPECTED_RECURRING_AMOUNT":
      return `rec:${String(value.fingerprint ?? `${String(value.currency)}:${String(value.amountMinor)}`)}`;
    case "ONE_TIME_EXPECTED_EXPENSE":
      return `onetime:${String(value.date)}:${String(value.direction)}:${String(value.accountId ?? "any")}:${String(value.currency)}:${String(value.amountMinor)}`;
    case "ACCOUNT_BEHAVIOR":
      return `acct:${String(value.accountId)}`;
    case "CUSTOM":
      return `custom:${freshId}`;
  }
}

function settingsHash(input: SettingsUpdateInput): string {
  return createHash("sha256")
    .update(JSON.stringify({ command: SETTINGS_UPDATE_COMMAND, workspaceId: input.workspaceId, expectedVersion: input.expectedVersion, horizonDays: input.horizonDays ?? null, baselineWeeks: input.baselineWeeks ?? null, safetyFloorMinor: input.safetyFloorMinor ?? null, savingsIncluded: input.savingsIncluded ?? null }))
    .digest("hex");
}

function setHash(input: SetAssumptionInput): string {
  return createHash("sha256")
    .update(JSON.stringify({ command: ASSUMPTION_SET_COMMAND, workspaceId: input.workspaceId, assumptionType: input.assumptionType, validFrom: input.validFrom, validTo: input.validTo, value: input.value, origin: input.origin, confidence: input.confidence }))
    .digest("hex");
}

function archiveHash(input: ArchiveAssumptionInput): string {
  return createHash("sha256")
    .update(JSON.stringify({ command: ASSUMPTION_ARCHIVE_COMMAND, workspaceId: input.workspaceId, assumptionId: input.assumptionId, expectedVersion: input.expectedVersion }))
    .digest("hex");
}

export async function updateSettingsTx(client: PoolClient, claims: TenantClaims, actorId: string, input: SettingsUpdateInput): Promise<TxOutcome<ProjectionSettingsView>> {
  const expected = BigInt(input.expectedVersion);
  return claimAndExecute(client, claims, actorId, SETTINGS_UPDATE_COMMAND, input.idempotencyKey, settingsHash(input), async (client, operationId) => {
    const current = await client.query("SELECT version, horizon_days, baseline_weeks, safety_floor_minor, savings_included FROM projection_settings WHERE workspace_id = $1", [claims.workspaceId]);
    const row = current.rows[0] as { version: string; horizon_days: number; baseline_weeks: number; safety_floor_minor: string; savings_included: boolean } | undefined;
    const currentVersion = row ? BigInt(String(row.version)) : 0n;
    if (currentVersion !== expected) throw new TxError("version_mismatch", row ? String(row.version) : "0");
    const next = {
      horizonDays: input.horizonDays ?? Number(row?.horizon_days ?? 30),
      baselineWeeks: input.baselineWeeks ?? Number(row?.baseline_weeks ?? 8),
      safetyFloorMinor: input.safetyFloorMinor ?? (row ? String(row.safety_floor_minor) : "0"),
      savingsIncluded: input.savingsIncluded ?? Boolean(row?.savings_included ?? false),
    };
    const nextVersion = (currentVersion + 1n).toString();
    if (row) {
      await client.query(
        "UPDATE projection_settings SET horizon_days = $1, baseline_weeks = $2, safety_floor_minor = $3, savings_included = $4, version = $5, updated_at = now() WHERE workspace_id = $6",
        [next.horizonDays, next.baselineWeeks, next.safetyFloorMinor, next.savingsIncluded, nextVersion, claims.workspaceId],
      );
    } else {
      await client.query(
        "INSERT INTO projection_settings (workspace_id, horizon_days, baseline_weeks, safety_floor_minor, savings_included, version) VALUES ($1, $2, $3, $4, $5, $6)",
        [claims.workspaceId, next.horizonDays, next.baselineWeeks, next.safetyFloorMinor, next.savingsIncluded, nextVersion],
      );
    }
    const view: ProjectionSettingsView = {
      workspaceId: claims.workspaceId,
      horizonDays: next.horizonDays,
      baselineWeeks: next.baselineWeeks,
      safetyFloorMinor: next.safetyFloorMinor,
      savingsIncluded: next.savingsIncluded,
      version: nextVersion,
      updatedAt: new Date().toISOString(),
    };
    await insertAudit(client, claims, actorId, "projection_settings", claims.workspaceId, row ? "update" : "create", row ?? null, view, operationId);
    await bumpRevision(client, claims.workspaceId);
    return { view, operationId };
  });
}

export async function setAssumptionTx(client: PoolClient, claims: TenantClaims, actorId: string, input: SetAssumptionInput): Promise<TxOutcome<AssumptionView>> {
  return claimAndExecute(client, claims, actorId, ASSUMPTION_SET_COMMAND, input.idempotencyKey, setHash(input), async (client, operationId) => {
    const id = uuidv7();
    const scope = scopeKeyFor(input.assumptionType, input.value, id);
    // Supersede the same-type/scope ACTIVE predecessors in this transaction;
    // history rows stay immutable, only their status flips.
    const prior = await client.query(
      "SELECT id FROM financial_assumptions WHERE workspace_id = $1 AND assumption_type = $2 AND scope_key = $3 AND status = 'ACTIVE' FOR UPDATE",
      [claims.workspaceId, input.assumptionType, scope],
    );
    const supersededIds = (prior.rows as { id: string }[]).map((r) => String(r.id));
    if (supersededIds.length > 0) {
      await client.query(
        "UPDATE financial_assumptions SET status = 'SUPERSEDED', updated_at = now() WHERE workspace_id = $1 AND assumption_type = $2 AND scope_key = $3 AND status = 'ACTIVE'",
        [claims.workspaceId, input.assumptionType, scope],
      );
    }
    await client.query(
      "INSERT INTO financial_assumptions (workspace_id, id, assumption_type, status, valid_from, valid_to, value, scope_key, origin, confidence, supersedes_id, actor_id, version) VALUES ($1, $2, $3, 'ACTIVE', $4, $5, $6, $7, $8, $9, $10, $11, '1')",
      [claims.workspaceId, id, input.assumptionType, input.validFrom, input.validTo, JSON.stringify(input.value), scope, input.origin, input.confidence, supersededIds[0] ?? null, actorId],
    );
    const view: AssumptionView = {
      workspaceId: claims.workspaceId,
      id,
      assumptionType: input.assumptionType,
      status: "ACTIVE",
      validFrom: input.validFrom,
      validTo: input.validTo,
      value: input.value,
      origin: input.origin,
      confidence: input.confidence,
      supersedesId: supersededIds[0] ?? null,
      version: "1",
      createdAt: new Date().toISOString(),
    };
    await insertAudit(client, claims, actorId, "financial_assumption", id, "create", null, { ...view, supersededIds }, operationId);
    await bumpRevision(client, claims.workspaceId);
    return { view, operationId };
  });
}

export async function archiveAssumptionTx(client: PoolClient, claims: TenantClaims, actorId: string, input: ArchiveAssumptionInput): Promise<TxOutcome<AssumptionView>> {
  const expected = BigInt(input.expectedVersion);
  return claimAndExecute(client, claims, actorId, ASSUMPTION_ARCHIVE_COMMAND, input.idempotencyKey, archiveHash(input), async (client, operationId) => {
    const found = await client.query("SELECT * FROM financial_assumptions WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [claims.workspaceId, input.assumptionId]);
    const row = found.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new TxError("not_found");
    if (BigInt(String(row.version)) !== expected) throw new TxError("version_mismatch", String(row.version));
    if (String(row.status) === "ARCHIVED") throw new TxError("version_mismatch", String(row.version));
    await client.query("UPDATE financial_assumptions SET status = 'ARCHIVED', version = version + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, input.assumptionId]);
    const view: AssumptionView = {
      workspaceId: claims.workspaceId,
      id: String(row.id),
      assumptionType: String(row.assumption_type),
      status: "ARCHIVED",
      validFrom: String(row.valid_from),
      validTo: row.valid_to === null ? null : String(row.valid_to),
      value: row.value as Record<string, unknown>,
      origin: String(row.origin),
      confidence: row.confidence === null ? null : String(row.confidence),
      supersedesId: row.supersedes_id === null ? null : String(row.supersedes_id),
      version: (BigInt(String(row.version)) + 1n).toString(),
      createdAt: String(row.created_at),
    };
    await insertAudit(client, claims, actorId, "financial_assumption", input.assumptionId, "archive", { status: String(row.status) }, view, operationId);
    await bumpRevision(client, claims.workspaceId);
    return { view, operationId };
  });
}

export type SettingsResult = { view: ProjectionSettingsView; operationId: string; replayed: boolean };
export type AssumptionResult = { view: AssumptionView; operationId: string; replayed: boolean };

function toTxError(outcome: { ok: false; code: TxError["code"]; currentVersion?: string; detail?: unknown }): TxError {
  return new TxError(outcome.code, outcome.currentVersion, outcome.detail);
}

export async function updateProjectionSettings(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<SettingsResult> {
  const input = validateSettingsUpdateInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => updateSettingsTx(client, claims, actorId, input));
  if (!outcome.ok) throw toTxError(outcome);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

export async function setAssumption(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<AssumptionResult> {
  const input = validateSetAssumptionInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => setAssumptionTx(client, claims, actorId, input));
  if (!outcome.ok) throw toTxError(outcome);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

export async function archiveAssumption(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<AssumptionResult> {
  const input = validateArchiveAssumptionInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => archiveAssumptionTx(client, claims, actorId, input));
  if (!outcome.ok) throw toTxError(outcome);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

export async function readProjectionSettings(pool: Pool, claims: TenantClaims, workspaceId: string): Promise<ProjectionSettingsView> {
  if (typeof workspaceId !== "string" || !isUuid(workspaceId)) throw new TenantInvalid();
  if (workspaceId !== claims.workspaceId) throw new TenantDenied();
  return withTenant(pool, claims, (client) => getProjectionSettings(client, claims.workspaceId));
}

export async function readAssumptions(pool: Pool, claims: TenantClaims, workspaceId: string, status: "ACTIVE" | "SUPERSEDED" | "ARCHIVED" | "ALL" = "ACTIVE"): Promise<AssumptionView[]> {
  if (typeof workspaceId !== "string" || !isUuid(workspaceId)) throw new TenantInvalid();
  if (workspaceId !== claims.workspaceId) throw new TenantDenied();
  if (status !== "ACTIVE" && status !== "SUPERSEDED" && status !== "ARCHIVED" && status !== "ALL") throw new TenantInvalid();
  return withTenant(pool, claims, (client) => listAssumptions(client, claims.workspaceId, status));
}

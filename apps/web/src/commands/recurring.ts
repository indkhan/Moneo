// E03-S07 recurring confirmation: deterministic candidates (pure
// src/recurring.ts) plus versioned confirm/dismiss overrides. Detection
// never writes; overrides never fabricate booked rows. Every mutation runs
// in one tenant transaction via the shared command journal (exported from
// commands/transactions.ts) with optimistic versions as decimal strings.

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isUuid, uuidv7 } from "../ids.ts";
import { formatDecimalBigint, parseDecimalBigint } from "../money.ts";
import {
  TxError,
  bumpRevision,
  claimAndExecute,
  insertAudit,
  type TxOutcome,
} from "./transactions.ts";
import { TenantDenied, TenantInvalid, withTenant, type TenantClaims } from "../tenancy.ts";
import { detectCandidates, type RecurringCandidate, type RecurringInput } from "../recurring.ts";

export const CONFIRM_COMMAND = "recurring.confirm";
export const DISMISS_COMMAND = "recurring.dismiss";

const SCAN_LIMIT = 2000;
const SURFACE_LIMIT = 200;
const FP_RE = /^[a-f0-9]{64}$/;

export type OverrideView = {
  workspaceId: string;
  fingerprint: string;
  status: "proposed" | "confirmed" | "dismissed";
  kind: "expense" | "income" | null;
  dayOfMonth: number | null;
  version: string;
  createdAt: string;
  updatedAt: string;
};

export type CandidateView = RecurringCandidate & { override: OverrideView | null; confirmVersion: string; confirmable: boolean };

function checkFingerprint(value: unknown): string {
  if (typeof value !== "string" || !FP_RE.test(value)) throw new TenantInvalid();
  return value;
}

function checkVersion(value: unknown): bigint {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) throw new TenantInvalid();
  try {
    return parseDecimalBigint(value);
  } catch {
    throw new TenantInvalid();
  }
}

export type ConfirmInput = {
  workspaceId: string;
  fingerprint: string;
  kind: "expense" | "income";
  dayOfMonth: number;
  expectedVersion: string;
  idempotencyKey: string;
};

export function validateConfirmInput(value: unknown): ConfirmInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!["workspaceId", "fingerprint", "kind", "dayOfMonth", "expectedVersion", "idempotencyKey"].includes(key)) throw new TenantInvalid();
  }
  if (v.kind !== "expense" && v.kind !== "income") throw new TenantInvalid();
  if (!Number.isInteger(v.dayOfMonth) || (v.dayOfMonth as number) < 1 || (v.dayOfMonth as number) > 28) throw new TenantInvalid();
  if (typeof v.expectedVersion !== "string" || !/^[0-9]+$/.test(v.expectedVersion)) throw new TenantInvalid();
  return {
    workspaceId: (() => {
      if (typeof v.workspaceId !== "string" || !isUuid(v.workspaceId)) throw new TenantInvalid();
      return v.workspaceId;
    })(),
    fingerprint: checkFingerprint(v.fingerprint),
    kind: v.kind,
    dayOfMonth: v.dayOfMonth as number,
    expectedVersion: v.expectedVersion,
    idempotencyKey: (() => {
      if (typeof v.idempotencyKey !== "string" || !isUuid(v.idempotencyKey)) throw new TenantInvalid();
      return v.idempotencyKey;
    })(),
  };
}

export type DismissInput = {
  workspaceId: string;
  fingerprint: string;
  expectedVersion: string;
  idempotencyKey: string;
};

export function validateDismissInput(value: unknown): DismissInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!["workspaceId", "fingerprint", "expectedVersion", "idempotencyKey"].includes(key)) throw new TenantInvalid();
  }
  if (typeof v.expectedVersion !== "string" || !/^[0-9]+$/.test(v.expectedVersion)) throw new TenantInvalid();
  return {
    workspaceId: (() => {
      if (typeof v.workspaceId !== "string" || !isUuid(v.workspaceId)) throw new TenantInvalid();
      return v.workspaceId;
    })(),
    fingerprint: checkFingerprint(v.fingerprint),
    expectedVersion: v.expectedVersion,
    idempotencyKey: (() => {
      if (typeof v.idempotencyKey !== "string" || !isUuid(v.idempotencyKey)) throw new TenantInvalid();
      return v.idempotencyKey;
    })(),
  };
}

type OverrideRow = {
  workspace_id: string;
  id: string;
  fingerprint: string;
  status: string;
  kind: string | null;
  day_of_month: number | null;
  version: string;
  created_at: string;
  updated_at: string;
};

function toOverrideView(row: OverrideRow): OverrideView {
  return {
    workspaceId: row.workspace_id,
    fingerprint: row.fingerprint,
    status: row.status as OverrideView["status"],
    kind: row.kind as OverrideView["kind"],
    dayOfMonth: row.day_of_month,
    version: formatDecimalBigint(BigInt(row.version)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function scanInputs(client: PoolClient, workspaceId: string): Promise<{ items: RecurringInput[]; truncated: boolean }> {
  const items: RecurringInput[] = [];
  let truncated = false;
  for (const table of ["transactions", "manual_transactions"] as const) {
    const rows = await client.query(
      `SELECT id, amount_minor, currency, direction, effective_date, description FROM ${table} WHERE workspace_id = $1 ORDER BY effective_date DESC LIMIT $2`,
      [workspaceId, SCAN_LIMIT + 1],
    );
    if (rows.rows.length > SCAN_LIMIT) truncated = true;
    for (const r of rows.rows.slice(0, SCAN_LIMIT) as { id: string; amount_minor: string; currency: string; direction: string; effective_date: string | Date; description: string }[]) {
      const date = r.effective_date instanceof Date
        ? `${r.effective_date.getUTCFullYear()}-${String(r.effective_date.getUTCMonth() + 1).padStart(2, "0")}-${String(r.effective_date.getUTCDate()).padStart(2, "0")}`
        : r.effective_date;
      const minor = BigInt(r.amount_minor) < 0n ? -BigInt(r.amount_minor) : BigInt(r.amount_minor);
      items.push({ id: r.id, amountMinor: minor.toString(10), currency: r.currency.trim(), direction: r.direction as "INFLOW" | "OUTFLOW", effectiveDate: date, description: r.description });
    }
  }
  return { items, truncated };
}

async function readOverride(client: PoolClient, workspaceId: string, fingerprint: string): Promise<OverrideView | null> {
  const found = await client.query("SELECT workspace_id, id, fingerprint, status, kind, day_of_month, version, created_at, updated_at FROM recurring_overrides WHERE workspace_id = $1 AND fingerprint = $2", [workspaceId, fingerprint]);
  if ((found.rowCount ?? 0) === 0) return null;
  return toOverrideView(found.rows[0] as OverrideRow);
}

export async function listRecurring(pool: Pool, claims: TenantClaims): Promise<{ candidates: CandidateView[]; scanned: number; truncated: boolean }> {
  return withTenant(pool, claims, async (client) => {
    const { items, truncated } = await scanInputs(client, claims.workspaceId);
    const detected = detectCandidates(items).slice(0, SURFACE_LIMIT);
    const overrides = await client.query("SELECT workspace_id, id, fingerprint, status, kind, day_of_month, version, created_at, updated_at FROM recurring_overrides WHERE workspace_id = $1", [claims.workspaceId]);
    const byFp = new Map((overrides.rows as OverrideRow[]).map((r) => [r.fingerprint, toOverrideView(r)]));
    return {
      candidates: detected.map((c) => {
        const override = byFp.get(c.fingerprint) ?? null;
        return { ...c, override, confirmVersion: override ? override.version : "0", confirmable: c.status === "candidate" };
      }),
      scanned: items.length,
      truncated,
    };
  });
}

function confirmHash(input: ConfirmInput): string {
  return createHash("sha256").update(JSON.stringify({ command: CONFIRM_COMMAND, workspaceId: input.workspaceId, fingerprint: input.fingerprint, kind: input.kind, dayOfMonth: input.dayOfMonth, expectedVersion: input.expectedVersion })).digest("hex");
}

export async function confirmTx(client: PoolClient, claims: TenantClaims, actorId: string, input: ConfirmInput): Promise<TxOutcome<OverrideView>> {
  const expected = checkVersion(input.expectedVersion);
  return claimAndExecute(client, claims, actorId, CONFIRM_COMMAND, input.idempotencyKey, confirmHash(input), async (client, operationId) => {
    // Liveness: the candidate must still be detected as a candidate —
    // vanished or sparse fingerprints cannot be confirmed.
    const { items } = await scanInputs(client, claims.workspaceId);
    const live = detectCandidates(items).find((c) => c.fingerprint === input.fingerprint);
    if (!live || live.status !== "candidate") throw new TxError("not_found");
    const current = await readOverride(client, claims.workspaceId, input.fingerprint);
    const currentVersion = current ? BigInt(current.version) : 0n;
    if (currentVersion !== expected) throw new TxError("version_mismatch", current ? current.version : "0");
    let view: OverrideView;
    if (!current) {
      const inserted = await client.query(
        "INSERT INTO recurring_overrides (workspace_id, id, fingerprint, status, kind, day_of_month) VALUES ($1, $2, $3, 'confirmed', $4, $5) RETURNING workspace_id, id, fingerprint, status, kind, day_of_month, version, created_at, updated_at",
        [claims.workspaceId, uuidv7(), input.fingerprint, input.kind, input.dayOfMonth],
      );
      view = toOverrideView(inserted.rows[0] as OverrideRow);
      await insertAudit(client, claims, actorId, "recurring_candidate", (inserted.rows[0] as OverrideRow).id, "confirm", null, view, operationId);
    } else {
      const updated = await client.query(
        "UPDATE recurring_overrides SET status = 'confirmed', kind = $1, day_of_month = $2, version = version + 1, updated_at = now() WHERE workspace_id = $3 AND fingerprint = $4 AND version = $5 RETURNING workspace_id, id, fingerprint, status, kind, day_of_month, version, created_at, updated_at",
        [input.kind, input.dayOfMonth, claims.workspaceId, input.fingerprint, expected.toString(10)],
      );
      if ((updated.rowCount ?? 0) === 0) {
        const latest = await readOverride(client, claims.workspaceId, input.fingerprint);
        throw new TxError("version_mismatch", latest?.version);
      }
      view = toOverrideView(updated.rows[0] as OverrideRow);
      await insertAudit(client, claims, actorId, "recurring_candidate", (updated.rows[0] as OverrideRow).id, "confirm", current, view, operationId);
    }
    await bumpRevision(client, claims.workspaceId);
    return { view, operationId };
  });
}

export async function confirm(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<{ view: OverrideView; operationId: string; replayed: boolean }> {
  const input = validateConfirmInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => confirmTx(client, claims, actorId, input));
  if (!outcome.ok) throw new TxError(outcome.code, outcome.currentVersion, outcome.detail);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

function dismissHash(input: DismissInput): string {
  return createHash("sha256").update(JSON.stringify({ command: DISMISS_COMMAND, workspaceId: input.workspaceId, fingerprint: input.fingerprint, expectedVersion: input.expectedVersion })).digest("hex");
}

export async function dismissTx(client: PoolClient, claims: TenantClaims, actorId: string, input: DismissInput): Promise<TxOutcome<OverrideView>> {
  const expected = checkVersion(input.expectedVersion);
  return claimAndExecute(client, claims, actorId, DISMISS_COMMAND, input.idempotencyKey, dismissHash(input), async (client, operationId) => {
    const { items } = await scanInputs(client, claims.workspaceId);
    const live = detectCandidates(items).find((c) => c.fingerprint === input.fingerprint);
    if (!live) throw new TxError("not_found");
    const current = await readOverride(client, claims.workspaceId, input.fingerprint);
    const currentVersion = current ? BigInt(current.version) : 0n;
    if (currentVersion !== expected) throw new TxError("version_mismatch", current ? current.version : "0");
    let view: OverrideView;
    if (!current) {
      const inserted = await client.query(
        "INSERT INTO recurring_overrides (workspace_id, id, fingerprint, status) VALUES ($1, $2, $3, 'dismissed') RETURNING workspace_id, id, fingerprint, status, kind, day_of_month, version, created_at, updated_at",
        [claims.workspaceId, uuidv7(), input.fingerprint],
      );
      view = toOverrideView(inserted.rows[0] as OverrideRow);
      await insertAudit(client, claims, actorId, "recurring_candidate", (inserted.rows[0] as OverrideRow).id, "dismiss", null, view, operationId);
    } else {
      const updated = await client.query(
        "UPDATE recurring_overrides SET status = 'dismissed', kind = NULL, day_of_month = NULL, version = version + 1, updated_at = now() WHERE workspace_id = $1 AND fingerprint = $2 AND version = $3 RETURNING workspace_id, id, fingerprint, status, kind, day_of_month, version, created_at, updated_at",
        [claims.workspaceId, input.fingerprint, expected.toString(10)],
      );
      if ((updated.rowCount ?? 0) === 0) {
        const latest = await readOverride(client, claims.workspaceId, input.fingerprint);
        throw new TxError("version_mismatch", latest?.version);
      }
      view = toOverrideView(updated.rows[0] as OverrideRow);
      await insertAudit(client, claims, actorId, "recurring_candidate", (updated.rows[0] as OverrideRow).id, "dismiss", current, view, operationId);
    }
    await bumpRevision(client, claims.workspaceId);
    return { view, operationId };
  });
}

export async function dismiss(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<{ view: OverrideView; operationId: string; replayed: boolean }> {
  const input = validateDismissInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => dismissTx(client, claims, actorId, input));
  if (!outcome.ok) throw new TxError(outcome.code, outcome.currentVersion, outcome.detail);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

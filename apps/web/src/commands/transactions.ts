// E03-S05 categories/tags, transaction correction, audit and supported undo.
// Shared domain module consumed by the HTTP adapter (AI/artifact adapters
// reuse this same module later). Every mutation runs in one tenant PG
// transaction via `command_operations` idempotency + optimistic BIGINT
// versions. Versions and minor units cross JSON strictly as decimal strings
// (BigInt math only, never floats). Audit rows in `audit_events` are
// append-only; undo emits a compensating command that references the
// original operation without rewriting history.

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isUuid, uuidv7 } from "../ids.ts";
import { currencyExponent, formatDecimalBigint, parseDecimalBigint, parseMinor } from "../money.ts";
import { TenantDenied, TenantInvalid, withTenant, type TenantClaims } from "../tenancy.ts";

export const CATEGORIES_CREATE_COMMAND = "categories.create";
export const CATEGORIES_ARCHIVE_COMMAND = "categories.archive";
export const TAGS_CREATE_COMMAND = "tags.create";
export const TAGS_ARCHIVE_COMMAND = "tags.archive";
export const SET_CATEGORY_COMMAND = "transactions.set_category";
export const ADD_TAG_COMMAND = "transactions.add_tag";
export const REMOVE_TAG_COMMAND = "transactions.remove_tag";
export const CORRECT_COMMAND = "transactions.correct";
export const UNDO_COMMAND = "operations.undo";

const REPLAY_RETENTION_DAYS = 30;

export type TransactionKind = "imported" | "manual";

export type CategoryView = {
  workspaceId: string;
  id: string;
  name: string;
  parentId: string | null;
  systemCategoryId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TagView = {
  workspaceId: string;
  id: string;
  name: string;
  normalizedName: string;
  archivedAt: string | null;
  createdAt: string;
};

export type SystemCategoryView = { id: string; code: string; name: string };

export type TransactionView = {
  workspaceId: string;
  kind: TransactionKind;
  id: string;
  accountId: string;
  amountMinor: string;
  currency: string;
  direction: "INFLOW" | "OUTFLOW";
  effectiveDate: string;
  description: string;
  categoryId: string | null;
  tagIds: string[];
  version: string;
  createdAt: string;
  updatedAt: string;
};

export type AuditView = {
  workspaceId: string;
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  beforeState: unknown;
  afterState: unknown;
  operationId: string | null;
  compensatingOperationId: string | null;
  createdAt: string;
};

export type CategoryResult = { view: CategoryView; operationId: string; replayed: boolean };
export type TagResult = { view: TagView; operationId: string; replayed: boolean };
export type TransactionResult = { view: TransactionView; operationId: string; replayed: boolean };
export type UndoResult = { view: TransactionView; operationId: string; replayed: boolean };

export class TxError extends Error {
  readonly code:
    | "not_found"
    | "version_mismatch"
    | "idempotency_reuse"
    | "idempotency_expired"
    | "undo_conflict"
    | "unsupported_undo"
    | "limit_exceeded"
    | "unsupported_operation";
  readonly currentVersion?: string;
  constructor(code: TxError["code"], currentVersion?: string) {
    super(code);
    this.code = code;
    this.currentVersion = currentVersion;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const POSITIVE_DECIMAL_RE = /^[0-9]+(\.[0-9]+)?$/;

function checkUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new TenantInvalid();
  return value;
}

function checkName(value: unknown): string {
  // Trimmed and reject-empty: whitespace-only names are not names (tags
  // already trim via normalizeTagName; categories match that boundary).
  if (typeof value !== "string") throw new TenantInvalid();
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 100) throw new TenantInvalid();
  return trimmed;
}

function checkDate(value: unknown): string {
  if (typeof value !== "string" || !DATE_RE.test(value)) throw new TenantInvalid();
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new TenantInvalid();
  return value;
}

function checkKind(value: unknown): TransactionKind {
  if (value !== "imported" && value !== "manual") throw new TenantInvalid();
  return value;
}

function normalizeTagName(name: string): string {
  return name.trim().toLowerCase();
}

function requestHash(obj: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

// ---- validators (HTTP validates once here; domain validates again) ----

export type CreateCategoryInput = {
  workspaceId: string;
  name: string;
  parentId?: string;
  systemCategoryId?: string;
  idempotencyKey: string;
};

export function validateCreateCategoryInput(value: unknown): CreateCategoryInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!["workspaceId", "name", "parentId", "systemCategoryId", "idempotencyKey"].includes(key)) throw new TenantInvalid();
  }
  const workspaceId = checkUuid(v.workspaceId);
  const name = checkName(v.name);
  const input: CreateCategoryInput = { workspaceId, name, idempotencyKey: checkUuid(v.idempotencyKey) };
  if (v.parentId !== undefined) input.parentId = checkUuid(v.parentId);
  if (v.systemCategoryId !== undefined) input.systemCategoryId = checkUuid(v.systemCategoryId);
  return input;
}

export type ArchiveCategoryInput = { workspaceId: string; categoryId: string; idempotencyKey: string };

export function validateArchiveCategoryInput(value: unknown): ArchiveCategoryInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!["workspaceId", "categoryId", "idempotencyKey"].includes(key)) throw new TenantInvalid();
  }
  return { workspaceId: checkUuid(v.workspaceId), categoryId: checkUuid(v.categoryId), idempotencyKey: checkUuid(v.idempotencyKey) };
}

export type CreateTagInput = { workspaceId: string; name: string; idempotencyKey: string };

export function validateCreateTagInput(value: unknown): CreateTagInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!["workspaceId", "name", "idempotencyKey"].includes(key)) throw new TenantInvalid();
  }
  return { workspaceId: checkUuid(v.workspaceId), name: checkName(v.name), idempotencyKey: checkUuid(v.idempotencyKey) };
}

export type ArchiveTagInput = { workspaceId: string; tagId: string; idempotencyKey: string };

export function validateArchiveTagInput(value: unknown): ArchiveTagInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!["workspaceId", "tagId", "idempotencyKey"].includes(key)) throw new TenantInvalid();
  }
  return { workspaceId: checkUuid(v.workspaceId), tagId: checkUuid(v.tagId), idempotencyKey: checkUuid(v.idempotencyKey) };
}

export type SetCategoryInput = {
  workspaceId: string;
  transactionKind: TransactionKind;
  transactionId: string;
  categoryId: string | null;
  expectedVersion: string;
  idempotencyKey: string;
};

export function validateSetCategoryInput(value: unknown): SetCategoryInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!["workspaceId", "transactionKind", "transactionId", "categoryId", "expectedVersion", "idempotencyKey"].includes(key)) throw new TenantInvalid();
  }
  const categoryId = v.categoryId === null ? null : checkUuid(v.categoryId);
  if (typeof v.expectedVersion !== "string" || !/^[0-9]+$/.test(v.expectedVersion)) throw new TenantInvalid();
  return {
    workspaceId: checkUuid(v.workspaceId),
    transactionKind: checkKind(v.transactionKind),
    transactionId: checkUuid(v.transactionId),
    categoryId,
    expectedVersion: v.expectedVersion,
    idempotencyKey: checkUuid(v.idempotencyKey),
  };
}

export type TagLinkInput = {
  workspaceId: string;
  transactionKind: TransactionKind;
  transactionId: string;
  tagId: string;
  expectedVersion: string;
  idempotencyKey: string;
};

export function validateTagLinkInput(value: unknown): TagLinkInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!["workspaceId", "transactionKind", "transactionId", "tagId", "expectedVersion", "idempotencyKey"].includes(key)) throw new TenantInvalid();
  }
  if (typeof v.expectedVersion !== "string" || !/^[0-9]+$/.test(v.expectedVersion)) throw new TenantInvalid();
  return {
    workspaceId: checkUuid(v.workspaceId),
    transactionKind: checkKind(v.transactionKind),
    transactionId: checkUuid(v.transactionId),
    tagId: checkUuid(v.tagId),
    expectedVersion: v.expectedVersion,
    idempotencyKey: checkUuid(v.idempotencyKey),
  };
}

export type CorrectInput = {
  workspaceId: string;
  transactionKind: TransactionKind;
  transactionId: string;
  expectedVersion: string;
  amount?: string;
  currency?: string;
  direction?: "INFLOW" | "OUTFLOW";
  effectiveDate?: string;
  description?: string;
  categoryId?: string | null;
  tagIds?: string[];
  idempotencyKey: string;
};

export function validateCorrectInput(value: unknown): CorrectInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!["workspaceId", "transactionKind", "transactionId", "expectedVersion", "amount", "currency", "direction", "effectiveDate", "description", "categoryId", "tagIds", "idempotencyKey"].includes(key)) throw new TenantInvalid();
  }
  const input: CorrectInput = {
    workspaceId: checkUuid(v.workspaceId),
    transactionKind: checkKind(v.transactionKind),
    transactionId: checkUuid(v.transactionId),
    expectedVersion: typeof v.expectedVersion === "string" && /^[0-9]+$/.test(v.expectedVersion) ? v.expectedVersion : (() => { throw new TenantInvalid(); })(),
    idempotencyKey: checkUuid(v.idempotencyKey),
  };
  const moneyFields = [v.amount, v.currency, v.direction].filter((f) => f !== undefined);
  if (moneyFields.length > 0 && moneyFields.length !== 3) throw new TenantInvalid();
  if (v.amount !== undefined) {
    if (typeof v.amount !== "string" || !POSITIVE_DECIMAL_RE.test(v.amount)) throw new TenantInvalid();
    if (typeof v.currency !== "string" || !/^[A-Z]{3}$/.test(v.currency) || currencyExponent(v.currency) === undefined) throw new TenantInvalid();
    if (v.direction !== "INFLOW" && v.direction !== "OUTFLOW") throw new TenantInvalid();
    input.amount = v.amount;
    input.currency = v.currency;
    input.direction = v.direction;
  }
  if (v.effectiveDate !== undefined) input.effectiveDate = checkDate(v.effectiveDate);
  if (v.description !== undefined) {
    if (typeof v.description !== "string" || v.description.length < 1 || v.description.length > 500) throw new TenantInvalid();
    input.description = v.description;
  }
  if (v.categoryId !== undefined) input.categoryId = v.categoryId === null ? null : checkUuid(v.categoryId);
  if (v.tagIds !== undefined) {
    if (!Array.isArray(v.tagIds) || v.tagIds.length > 20) throw new TenantInvalid();
    const seen = new Set<string>();
    for (const t of v.tagIds) {
      const id = checkUuid(t);
      if (seen.has(id)) throw new TenantInvalid();
      seen.add(id);
    }
    input.tagIds = [...seen];
  }
  if (
    input.amount === undefined &&
    input.effectiveDate === undefined &&
    input.description === undefined &&
    input.categoryId === undefined &&
    input.tagIds === undefined
  ) {
    throw new TenantInvalid();
  }
  return input;
}

export type UndoInput = { workspaceId: string; operationId: string; idempotencyKey: string };

export function validateUndoInput(value: unknown): UndoInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!["workspaceId", "operationId", "idempotencyKey"].includes(key)) throw new TenantInvalid();
  }
  return { workspaceId: checkUuid(v.workspaceId), operationId: checkUuid(v.operationId), idempotencyKey: checkUuid(v.idempotencyKey) };
}

// ---- row mapping ----

type CategoryRow = { workspace_id: string; id: string; name: string; parent_id: string | null; system_category_id: string | null; archived_at: string | null; created_at: string; updated_at: string };
type TagRow = { workspace_id: string; id: string; name: string; normalized_name: string; archived_at: string | null; created_at: string };

function toCategoryView(row: CategoryRow): CategoryView {
  return { workspaceId: row.workspace_id, id: row.id, name: row.name, parentId: row.parent_id, systemCategoryId: row.system_category_id, archivedAt: row.archived_at, createdAt: row.created_at, updatedAt: row.updated_at };
}

function toTagView(row: TagRow): TagView {
  return { workspaceId: row.workspace_id, id: row.id, name: row.name, normalizedName: row.normalized_name, archivedAt: row.archived_at, createdAt: row.created_at };
}

function tableFor(kind: TransactionKind): "transactions" | "manual_transactions" {
  return kind === "imported" ? "transactions" : "manual_transactions";
}

function fmtDate(value: string | Date): string {
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
  }
  return value;
}

// ---- idempotency journal (same table/pattern as accounts.ts) ----

type StoredOp = {
  operationId: string;
  status: string;
  requestHash: string;
  response: unknown;
  error: { code: TxError["code"]; currentVersion?: string } | null;
  expiresAt: string;
};

type TxOutcome<T> = { ok: true; result: T; operationId: string; replayed: boolean } | { ok: false; code: TxError["code"]; currentVersion?: string };

async function claimAndExecute<T>(
  client: PoolClient,
  claims: TenantClaims,
  actorId: string,
  command: string,
  idempotencyKey: string,
  hash: string,
  execute: (client: PoolClient, operationId: string) => Promise<{ view: T; operationId: string }>,
): Promise<TxOutcome<T>> {
  const readOp = async (): Promise<StoredOp | undefined> => {
    const found = await client.query(
      "SELECT id AS \"operationId\", status, request_hash AS \"requestHash\", response_payload AS \"response\", error_payload AS \"error\", expires_at AS \"expiresAt\" FROM command_operations WHERE workspace_id = $1 AND command_name = $2 AND idempotency_key = $3",
      [claims.workspaceId, command, idempotencyKey],
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
    await client.query("SAVEPOINT tx_claim");
    let claimed = false;
    try {
      await client.query(
        "INSERT INTO command_operations (workspace_id, id, command_name, idempotency_key, request_hash, actor_id, status, expires_at) VALUES ($1, $2, $3, $4, $5, $6, 'FAILED_FINAL', now() + ($7 || ' days')::interval)",
        [claims.workspaceId, operationId, command, idempotencyKey, hash, actorId, String(REPLAY_RETENTION_DAYS)],
      );
      claimed = true;
    } catch (err) {
      if ((err as { code?: string }).code !== "23505") throw err;
      await client.query("ROLLBACK TO SAVEPOINT tx_claim");
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
      await client.query("SAVEPOINT tx_execute");
      try {
        const { view } = await execute(client, operationId);
        await client.query("UPDATE command_operations SET status = 'SUCCEEDED', response_payload = $1, completed_at = now() WHERE workspace_id = $2 AND id = $3", [
          JSON.stringify({ view, operationId, replayed: false }),
          claims.workspaceId,
          operationId,
        ]);
        return { ok: true, result: view, operationId, replayed: false };
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT tx_execute");
        if (err instanceof TxError) {
          await client.query("UPDATE command_operations SET status = 'FAILED_FINAL', error_payload = $1, completed_at = now() WHERE workspace_id = $2 AND id = $3", [
            JSON.stringify(err.currentVersion === undefined ? { code: err.code } : { code: err.code, currentVersion: err.currentVersion }),
            claims.workspaceId,
            operationId,
          ]);
          return { ok: false, code: err.code, currentVersion: err.currentVersion };
        }
        if ((err as { code?: string }).code === "23503") {
          await client.query("UPDATE command_operations SET status = 'FAILED_FINAL', error_payload = $1, completed_at = now() WHERE workspace_id = $2 AND id = $3", [
            JSON.stringify({ code: "not_found" }),
            claims.workspaceId,
            operationId,
          ]);
          return { ok: false, code: "not_found" };
        }
        throw err;
      }
    } catch (err) {
      if (err instanceof TxError) {
        await client.query("UPDATE command_operations SET status = 'FAILED_FINAL', error_payload = $1, completed_at = now() WHERE workspace_id = $2 AND id = $3", [
          JSON.stringify(err.currentVersion === undefined ? { code: err.code } : { code: err.code, currentVersion: err.currentVersion }),
          claims.workspaceId,
          operationId,
        ]);
        return { ok: false, code: err.code, currentVersion: err.currentVersion };
      }
      throw err;
    }
  }
  throw new Error("command_claim_unsettled");
}

async function insertAudit(
  client: PoolClient,
  claims: TenantClaims,
  actorId: string,
  entityType: string,
  entityId: string,
  action: string,
  beforeState: unknown,
  afterState: unknown,
  operationId: string,
  compensatingOperationId: string | null = null,
): Promise<string> {
  const id = uuidv7();
  await client.query(
    "INSERT INTO audit_events (workspace_id, id, actor_type, actor_user_id, entity_type, entity_id, action, before_state, after_state, operation_id, compensating_operation_id) VALUES ($1, $2, 'user', $3, $4, $5, $6, $7, $8, $9, $10)",
    [claims.workspaceId, id, actorId, entityType, entityId, action, JSON.stringify(beforeState ?? null), JSON.stringify(afterState ?? null), operationId, compensatingOperationId],
  );
  return id;
}

async function bumpRevision(client: PoolClient, workspaceId: string): Promise<void> {
  await client.query(
    "INSERT INTO workspace_data_revision (workspace_id, revision, updated_at) VALUES ($1, 1, now()) ON CONFLICT (workspace_id) DO UPDATE SET revision = workspace_data_revision.revision + 1, updated_at = now()",
    [workspaceId],
  );
}

async function readTransactionView(client: PoolClient, workspaceId: string, kind: TransactionKind, id: string): Promise<TransactionView | null> {
  const table = tableFor(kind);
  const rows = await client.query(
    `SELECT workspace_id, id, account_id, amount_minor, currency, direction, effective_date, description, category_id, version, created_at, updated_at FROM ${table} WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id],
  );
  if ((rows.rowCount ?? 0) === 0) return null;
  const r = rows.rows[0] as { workspace_id: string; id: string; account_id: string; amount_minor: string; currency: string; direction: string; effective_date: string | Date; description: string; category_id: string | null; version: string; created_at: string; updated_at: string };
  let tagIds: string[] = [];
  if (kind === "imported") {
    const tags = await client.query("SELECT tag_id FROM transaction_tags WHERE workspace_id = $1 AND transaction_id = $2 ORDER BY tag_id", [workspaceId, id]);
    tagIds = (tags.rows as { tag_id: string }[]).map((t) => t.tag_id);
  }
  return {
    workspaceId: r.workspace_id,
    kind,
    id: r.id,
    accountId: r.account_id,
    amountMinor: formatDecimalBigint(BigInt(r.amount_minor) < 0n ? -BigInt(r.amount_minor) : BigInt(r.amount_minor)),
    currency: r.currency.trim(),
    direction: r.direction as "INFLOW" | "OUTFLOW",
    effectiveDate: fmtDate(r.effective_date),
    description: r.description,
    categoryId: r.category_id,
    tagIds,
    version: formatDecimalBigint(BigInt(r.version)),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---- categories ----

export async function createCategoryTx(client: PoolClient, claims: TenantClaims, actorId: string, input: CreateCategoryInput): Promise<TxOutcome<CategoryView>> {
  const hash = requestHash({ command: CATEGORIES_CREATE_COMMAND, workspaceId: input.workspaceId, name: input.name, parentId: input.parentId ?? null, systemCategoryId: input.systemCategoryId ?? null });
  return claimAndExecute(client, claims, actorId, CATEGORIES_CREATE_COMMAND, input.idempotencyKey, hash, async (client, operationId) => {
    if (input.parentId !== undefined) {
      const parent = await client.query("SELECT id FROM categories WHERE workspace_id = $1 AND id = $2 AND archived_at IS NULL", [claims.workspaceId, input.parentId]);
      if ((parent.rowCount ?? 0) === 0) throw new TxError("not_found");
    }
    if (input.systemCategoryId !== undefined) {
      const sys = await client.query("SELECT id FROM system_categories WHERE id = $1 AND is_active", [input.systemCategoryId]);
      if ((sys.rowCount ?? 0) === 0) throw new TxError("not_found");
    }
    const count = await client.query("SELECT COUNT(*) AS c FROM categories WHERE workspace_id = $1 AND archived_at IS NULL", [claims.workspaceId]);
    if (Number((count.rows[0] as { c: string }).c) >= 500) throw new TxError("limit_exceeded");
    const id = uuidv7();
    let row: CategoryRow;
    try {
      const inserted = await client.query(
        "INSERT INTO categories (workspace_id, id, parent_id, name, system_category_id) VALUES ($1, $2, $3, $4, $5) RETURNING workspace_id, id, name, parent_id, system_category_id, archived_at, created_at, updated_at",
        [claims.workspaceId, id, input.parentId ?? null, input.name, input.systemCategoryId ?? null],
      );
      row = inserted.rows[0] as CategoryRow;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new TxError("idempotency_reuse");
      throw err;
    }
    const view = toCategoryView(row);
    await insertAudit(client, claims, actorId, "category", id, "create", null, view, operationId);
    await bumpRevision(client, claims.workspaceId);
    return { view, operationId };
  });
}

export async function createCategory(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<CategoryResult> {
  const input = validateCreateCategoryInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => createCategoryTx(client, claims, actorId, input));
  if (!outcome.ok) throw new TxError(outcome.code, outcome.currentVersion);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

export async function archiveCategoryTx(client: PoolClient, claims: TenantClaims, actorId: string, input: ArchiveCategoryInput): Promise<TxOutcome<CategoryView>> {
  const hash = requestHash({ command: CATEGORIES_ARCHIVE_COMMAND, workspaceId: input.workspaceId, categoryId: input.categoryId });
  return claimAndExecute(client, claims, actorId, CATEGORIES_ARCHIVE_COMMAND, input.idempotencyKey, hash, async (client, operationId) => {
    const found = await client.query("SELECT workspace_id, id, name, parent_id, system_category_id, archived_at, created_at, updated_at FROM categories WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, input.categoryId]);
    if ((found.rowCount ?? 0) === 0) throw new TxError("not_found");
    const before = toCategoryView(found.rows[0] as CategoryRow);
    const updated = await client.query(
      "UPDATE categories SET archived_at = COALESCE(archived_at, now()), updated_at = now() WHERE workspace_id = $1 AND id = $2 RETURNING workspace_id, id, name, parent_id, system_category_id, archived_at, created_at, updated_at",
      [claims.workspaceId, input.categoryId],
    );
    const view = toCategoryView(updated.rows[0] as CategoryRow);
    await insertAudit(client, claims, actorId, "category", input.categoryId, "archive", before, view, operationId);
    await bumpRevision(client, claims.workspaceId);
    return { view, operationId };
  });
}

export async function archiveCategory(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<CategoryResult> {
  const input = validateArchiveCategoryInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => archiveCategoryTx(client, claims, actorId, input));
  if (!outcome.ok) throw new TxError(outcome.code, outcome.currentVersion);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

export async function listCategories(pool: Pool, claims: TenantClaims, includeArchived = false): Promise<CategoryView[]> {
  return withTenant(pool, claims, async (client) => {
    const rows = await client.query(
      includeArchived
        ? "SELECT workspace_id, id, name, parent_id, system_category_id, archived_at, created_at, updated_at FROM categories WHERE workspace_id = $1 ORDER BY created_at"
        : "SELECT workspace_id, id, name, parent_id, system_category_id, archived_at, created_at, updated_at FROM categories WHERE workspace_id = $1 AND archived_at IS NULL ORDER BY created_at",
      [claims.workspaceId],
    );
    return (rows.rows as CategoryRow[]).map(toCategoryView);
  });
}

export async function listSystemCategories(pool: Pool): Promise<SystemCategoryView[]> {
  const rows = await pool.query("SELECT id, code, name FROM system_categories WHERE is_active ORDER BY code");
  return rows.rows as SystemCategoryView[];
}

// ---- tags ----

export async function createTagTx(client: PoolClient, claims: TenantClaims, actorId: string, input: CreateTagInput): Promise<TxOutcome<TagView>> {
  const normalized = normalizeTagName(input.name);
  if (normalized.length < 1 || normalized.length > 100) throw new TenantInvalid();
  const hash = requestHash({ command: TAGS_CREATE_COMMAND, workspaceId: input.workspaceId, normalized });
  return claimAndExecute(client, claims, actorId, TAGS_CREATE_COMMAND, input.idempotencyKey, hash, async (client, operationId) => {
    const count = await client.query("SELECT COUNT(*) AS c FROM tags WHERE workspace_id = $1 AND archived_at IS NULL", [claims.workspaceId]);
    if (Number((count.rows[0] as { c: string }).c) >= 500) throw new TxError("limit_exceeded");
    const dupe = await client.query("SELECT id FROM tags WHERE workspace_id = $1 AND normalized_name = $2 AND archived_at IS NULL", [claims.workspaceId, normalized]);
    if ((dupe.rowCount ?? 0) > 0) throw new TxError("idempotency_reuse");
    const id = uuidv7();
    // B1: the SELECT pre-check races under concurrency; the partial unique
    // index is the arbiter — map its violation to the same 409 contract.
    let inserted;
    try {
      inserted = await client.query(
        "INSERT INTO tags (workspace_id, id, name, normalized_name) VALUES ($1, $2, $3, $4) RETURNING workspace_id, id, name, normalized_name, archived_at, created_at",
        [claims.workspaceId, id, input.name.trim(), normalized],
      );
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new TxError("idempotency_reuse");
      throw err;
    }
    const view = toTagView(inserted.rows[0] as TagRow);
    await insertAudit(client, claims, actorId, "tag", id, "create", null, view, operationId);
    await bumpRevision(client, claims.workspaceId);
    return { view, operationId };
  });
}

export async function createTag(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<TagResult> {
  const input = validateCreateTagInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => createTagTx(client, claims, actorId, input));
  if (!outcome.ok) throw new TxError(outcome.code, outcome.currentVersion);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

export async function archiveTagTx(client: PoolClient, claims: TenantClaims, actorId: string, input: ArchiveTagInput): Promise<TxOutcome<TagView>> {
  const hash = requestHash({ command: TAGS_ARCHIVE_COMMAND, workspaceId: input.workspaceId, tagId: input.tagId });
  return claimAndExecute(client, claims, actorId, TAGS_ARCHIVE_COMMAND, input.idempotencyKey, hash, async (client, operationId) => {
    const found = await client.query("SELECT workspace_id, id, name, normalized_name, archived_at, created_at FROM tags WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, input.tagId]);
    if ((found.rowCount ?? 0) === 0) throw new TxError("not_found");
    const before = toTagView(found.rows[0] as TagRow);
    const updated = await client.query(
      "UPDATE tags SET archived_at = COALESCE(archived_at, now()) WHERE workspace_id = $1 AND id = $2 RETURNING workspace_id, id, name, normalized_name, archived_at, created_at",
      [claims.workspaceId, input.tagId],
    );
    const view = toTagView(updated.rows[0] as TagRow);
    await insertAudit(client, claims, actorId, "tag", input.tagId, "archive", before, view, operationId);
    await bumpRevision(client, claims.workspaceId);
    return { view, operationId };
  });
}

export async function archiveTag(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<TagResult> {
  const input = validateArchiveTagInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => archiveTagTx(client, claims, actorId, input));
  if (!outcome.ok) throw new TxError(outcome.code, outcome.currentVersion);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

export async function listTags(pool: Pool, claims: TenantClaims, includeArchived = false): Promise<TagView[]> {
  return withTenant(pool, claims, async (client) => {
    const rows = await client.query(
      includeArchived
        ? "SELECT workspace_id, id, name, normalized_name, archived_at, created_at FROM tags WHERE workspace_id = $1 ORDER BY created_at"
        : "SELECT workspace_id, id, name, normalized_name, archived_at, created_at FROM tags WHERE workspace_id = $1 AND archived_at IS NULL ORDER BY created_at",
      [claims.workspaceId],
    );
    return (rows.rows as TagRow[]).map(toTagView);
  });
}

// ---- transaction mutations ----

async function requireVersion(input: string): Promise<bigint> {
  try {
    return parseDecimalBigint(input);
  } catch {
    throw new TenantInvalid();
  }
}

async function requireLiveCategory(client: PoolClient, workspaceId: string, categoryId: string): Promise<void> {
  const found = await client.query("SELECT id FROM categories WHERE workspace_id = $1 AND id = $2 AND archived_at IS NULL", [workspaceId, categoryId]);
  if ((found.rowCount ?? 0) === 0) throw new TxError("not_found");
}

async function requireLiveTag(client: PoolClient, workspaceId: string, tagId: string): Promise<void> {
  const found = await client.query("SELECT id FROM tags WHERE workspace_id = $1 AND id = $2 AND archived_at IS NULL", [workspaceId, tagId]);
  if ((found.rowCount ?? 0) === 0) throw new TxError("not_found");
}

export async function setCategoryTx(client: PoolClient, claims: TenantClaims, actorId: string, input: SetCategoryInput): Promise<TxOutcome<TransactionView>> {
  const expected = await requireVersion(input.expectedVersion);
  const hash = requestHash({ command: SET_CATEGORY_COMMAND, workspaceId: input.workspaceId, kind: input.transactionKind, transactionId: input.transactionId, categoryId: input.categoryId, expectedVersion: input.expectedVersion });
  return claimAndExecute(client, claims, actorId, SET_CATEGORY_COMMAND, input.idempotencyKey, hash, async (client, operationId) => {
    if (input.categoryId !== null) await requireLiveCategory(client, claims.workspaceId, input.categoryId);
    const before = await readTransactionView(client, claims.workspaceId, input.transactionKind, input.transactionId);
    if (!before) throw new TxError("not_found");
    if (BigInt(before.version) !== expected) throw new TxError("version_mismatch", before.version);
    const table = tableFor(input.transactionKind);
    const updated = await client.query(
      `UPDATE ${table} SET category_id = $1, version = version + 1, updated_at = now() WHERE workspace_id = $2 AND id = $3 AND version = $4 RETURNING version`,
      [input.categoryId, claims.workspaceId, input.transactionId, expected.toString(10)],
    );
    if ((updated.rowCount ?? 0) === 0) {
      const current = await readTransactionView(client, claims.workspaceId, input.transactionKind, input.transactionId);
      throw new TxError("version_mismatch", current?.version);
    }
    const after = (await readTransactionView(client, claims.workspaceId, input.transactionKind, input.transactionId))!;
    await insertAudit(client, claims, actorId, input.transactionKind === "imported" ? "transaction" : "manual_transaction", input.transactionId, "set_category", before, after, operationId);
    await bumpRevision(client, claims.workspaceId);
    return { view: after, operationId };
  });
}

export async function setCategory(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<TransactionResult> {
  const input = validateSetCategoryInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  if (!isUuid(input.transactionId)) throw new TenantDenied();
  if (input.categoryId !== null && !isUuid(input.categoryId)) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => setCategoryTx(client, claims, actorId, input));
  if (!outcome.ok) throw new TxError(outcome.code, outcome.currentVersion);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

export async function addTagTx(client: PoolClient, claims: TenantClaims, actorId: string, input: TagLinkInput): Promise<TxOutcome<TransactionView>> {
  const expected = await requireVersion(input.expectedVersion);
  const hash = requestHash({ command: ADD_TAG_COMMAND, workspaceId: input.workspaceId, kind: input.transactionKind, transactionId: input.transactionId, tagId: input.tagId, expectedVersion: input.expectedVersion });
  return claimAndExecute(client, claims, actorId, ADD_TAG_COMMAND, input.idempotencyKey, hash, async (client, operationId) => {
    // Tags attach to imported transactions only in R1: transaction_tags has
    // no manual-transactions leg (documented limitation, honest 400).
    if (input.transactionKind !== "imported") throw new TxError("unsupported_operation");
    await requireLiveTag(client, claims.workspaceId, input.tagId);
    const before = await readTransactionView(client, claims.workspaceId, input.transactionKind, input.transactionId);
    if (!before) throw new TxError("not_found");
    if (BigInt(before.version) !== expected) throw new TxError("version_mismatch", before.version);
    const existing = await client.query("SELECT 1 FROM transaction_tags WHERE workspace_id = $1 AND transaction_id = $2 AND tag_id = $3", [claims.workspaceId, input.transactionId, input.tagId]);
    if ((existing.rowCount ?? 0) === 0) {
      const count = await client.query("SELECT COUNT(*) AS c FROM transaction_tags WHERE workspace_id = $1 AND transaction_id = $2", [claims.workspaceId, input.transactionId]);
      if (Number((count.rows[0] as { c: string }).c) >= 20) throw new TxError("limit_exceeded");
      // A 23505 here means a concurrent adder won the same link between our
      // check and insert — savepoint-guard it (a failed query would poison
      // the transaction) and report the honest version conflict.
      await client.query("SAVEPOINT tag_link");
      try {
        await client.query("INSERT INTO transaction_tags (workspace_id, transaction_id, tag_id) VALUES ($1, $2, $3)", [claims.workspaceId, input.transactionId, input.tagId]);
        await client.query("RELEASE SAVEPOINT tag_link");
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT tag_link");
        if ((err as { code?: string }).code === "23505") {
          const current = await readTransactionView(client, claims.workspaceId, input.transactionKind, input.transactionId);
          throw new TxError("version_mismatch", current?.version);
        }
        throw err;
      }
      // B2: atomic CAS on the version — concurrent adders on one version
      // converge to exactly one winner instead of silently double-bumping.
      const bumped = await client.query("UPDATE transactions SET version = version + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2 AND version = $3", [claims.workspaceId, input.transactionId, expected.toString(10)]);
      if ((bumped.rowCount ?? 0) === 0) {
        const current = await readTransactionView(client, claims.workspaceId, input.transactionKind, input.transactionId);
        throw new TxError("version_mismatch", current?.version);
      }
    }
    const after = (await readTransactionView(client, claims.workspaceId, input.transactionKind, input.transactionId))!;
    await insertAudit(client, claims, actorId, "transaction", input.transactionId, "add_tag", before, after, operationId);
    await bumpRevision(client, claims.workspaceId);
    return { view: after, operationId };
  });
}

export async function addTag(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<TransactionResult> {
  const input = validateTagLinkInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => addTagTx(client, claims, actorId, input));
  if (!outcome.ok) throw new TxError(outcome.code, outcome.currentVersion);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

export async function removeTagTx(client: PoolClient, claims: TenantClaims, actorId: string, input: TagLinkInput): Promise<TxOutcome<TransactionView>> {
  const expected = await requireVersion(input.expectedVersion);
  const hash = requestHash({ command: REMOVE_TAG_COMMAND, workspaceId: input.workspaceId, kind: input.transactionKind, transactionId: input.transactionId, tagId: input.tagId, expectedVersion: input.expectedVersion });
  return claimAndExecute(client, claims, actorId, REMOVE_TAG_COMMAND, input.idempotencyKey, hash, async (client, operationId) => {
    if (input.transactionKind !== "imported") throw new TxError("unsupported_operation");
    const before = await readTransactionView(client, claims.workspaceId, input.transactionKind, input.transactionId);
    if (!before) throw new TxError("not_found");
    if (BigInt(before.version) !== expected) throw new TxError("version_mismatch", before.version);
    const deleted = await client.query("DELETE FROM transaction_tags WHERE workspace_id = $1 AND transaction_id = $2 AND tag_id = $3", [claims.workspaceId, input.transactionId, input.tagId]);
    if ((deleted.rowCount ?? 0) > 0) {
      const bumped = await client.query("UPDATE transactions SET version = version + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2 AND version = $3", [claims.workspaceId, input.transactionId, expected.toString(10)]);
      if ((bumped.rowCount ?? 0) === 0) {
        const current = await readTransactionView(client, claims.workspaceId, input.transactionKind, input.transactionId);
        throw new TxError("version_mismatch", current?.version);
      }
    }
    const after = (await readTransactionView(client, claims.workspaceId, input.transactionKind, input.transactionId))!;
    await insertAudit(client, claims, actorId, "transaction", input.transactionId, "remove_tag", before, after, operationId);
    await bumpRevision(client, claims.workspaceId);
    return { view: after, operationId };
  });
}

export async function removeTag(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<TransactionResult> {
  const input = validateTagLinkInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => removeTagTx(client, claims, actorId, input));
  if (!outcome.ok) throw new TxError(outcome.code, outcome.currentVersion);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

export async function correctTx(client: PoolClient, claims: TenantClaims, actorId: string, input: CorrectInput): Promise<TxOutcome<TransactionView>> {
  const expected = await requireVersion(input.expectedVersion);
  const hash = requestHash({ command: CORRECT_COMMAND, workspaceId: input.workspaceId, kind: input.transactionKind, transactionId: input.transactionId, amount: input.amount ?? null, currency: input.currency ?? null, direction: input.direction ?? null, effectiveDate: input.effectiveDate ?? null, description: input.description ?? null, categoryId: input.categoryId === undefined ? "UNCHANGED" : input.categoryId, tagIds: input.tagIds ?? "UNCHANGED", expectedVersion: input.expectedVersion });
  return claimAndExecute(client, claims, actorId, CORRECT_COMMAND, input.idempotencyKey, hash, async (client, operationId) => {
    if (input.categoryId !== undefined && input.categoryId !== null) await requireLiveCategory(client, claims.workspaceId, input.categoryId);
    if (input.tagIds !== undefined) {
      // Tag replacement shares the imported-only transaction_tags leg (see
      // addTagTx); manual corrections use category/field paths instead.
      if (input.transactionKind !== "imported") throw new TxError("unsupported_operation");
      for (const tagId of input.tagIds) await requireLiveTag(client, claims.workspaceId, tagId);
    }
    let minor: bigint | null = null;
    if (input.amount !== undefined) {
      minor = parseMinor(input.amount, input.currency!);
      if (minor <= 0n) throw new TenantInvalid();
    }
    const before = await readTransactionView(client, claims.workspaceId, input.transactionKind, input.transactionId);
    if (!before) throw new TxError("not_found");
    if (BigInt(before.version) !== expected) throw new TxError("version_mismatch", before.version);
    const table = tableFor(input.transactionKind);
    const sets: string[] = ["version = version + 1", "updated_at = now()"];
    const params: unknown[] = [claims.workspaceId, input.transactionId, expected.toString(10)];
    let idx = 4;
    if (minor !== null) {
      sets.push(`amount_minor = $${idx++}`, `currency = $${idx++}`, `direction = $${idx++}`);
      params.push(minor.toString(10), input.currency!, input.direction!);
    }
    if (input.effectiveDate !== undefined) {
      sets.push(`effective_date = $${idx++}`);
      params.push(input.effectiveDate);
    }
    if (input.description !== undefined) {
      sets.push(`description = $${idx++}`);
      params.push(input.description);
    }
    if (input.categoryId !== undefined) {
      sets.push(`category_id = $${idx++}`);
      params.push(input.categoryId);
    }
    const updated = await client.query(`UPDATE ${table} SET ${sets.join(", ")} WHERE workspace_id = $1 AND id = $2 AND version = $3 RETURNING version`, params);
    if ((updated.rowCount ?? 0) === 0) {
      const current = await readTransactionView(client, claims.workspaceId, input.transactionKind, input.transactionId);
      throw new TxError("version_mismatch", current?.version);
    }
    if (input.tagIds !== undefined) {
      await client.query("DELETE FROM transaction_tags WHERE workspace_id = $1 AND transaction_id = $2", [claims.workspaceId, input.transactionId]);
      for (const tagId of input.tagIds) {
        await client.query("INSERT INTO transaction_tags (workspace_id, transaction_id, tag_id) VALUES ($1, $2, $3)", [claims.workspaceId, input.transactionId, tagId]);
      }
    }
    const after = (await readTransactionView(client, claims.workspaceId, input.transactionKind, input.transactionId))!;
    await insertAudit(client, claims, actorId, input.transactionKind === "imported" ? "transaction" : "manual_transaction", input.transactionId, "correct", before, after, operationId);
    await bumpRevision(client, claims.workspaceId);
    return { view: after, operationId };
  });
}

export async function correct(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<TransactionResult> {
  // N6: HTTP validates once here; the *Tx variants trust typed input from
  // their caller (same caveat as S04 renameAccountTx) — future AI/artifact
  // adapters must pass validated input or call these wrappers, never raw SQL.
  const input = validateCorrectInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  if (!isUuid(input.transactionId)) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => correctTx(client, claims, actorId, input));
  if (!outcome.ok) throw new TxError(outcome.code, outcome.currentVersion);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

// ---- undo ----

const UNDOABLE = new Set([SET_CATEGORY_COMMAND, ADD_TAG_COMMAND, REMOVE_TAG_COMMAND, CORRECT_COMMAND]);

export async function undoTx(client: PoolClient, claims: TenantClaims, actorId: string, input: UndoInput): Promise<TxOutcome<TransactionView>> {
  const hash = requestHash({ command: UNDO_COMMAND, workspaceId: input.workspaceId, operationId: input.operationId });
  return claimAndExecute(client, claims, actorId, UNDO_COMMAND, input.idempotencyKey, hash, async (client, operationId) => {
    const op = await client.query("SELECT command_name, status FROM command_operations WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, input.operationId]);
    if ((op.rowCount ?? 0) === 0) throw new TxError("not_found");
    const commandName = (op.rows[0] as { command_name: string }).command_name;
    if ((op.rows[0] as { status: string }).status !== "SUCCEEDED") throw new TxError("undo_conflict");
    if (!UNDOABLE.has(commandName)) throw new TxError("unsupported_undo");
    const audits = await client.query(
      "SELECT entity_type, entity_id, before_state, after_state FROM audit_events WHERE workspace_id = $1 AND operation_id = $2 ORDER BY created_at",
      [claims.workspaceId, input.operationId],
    );
    // N5: exactly one audit row per undoable operation is today's invariant;
    // more than one means the operation shape changed — refuse, don't guess.
    if ((audits.rowCount ?? 0) !== 1) {
      if ((audits.rowCount ?? 0) === 0) throw new TxError("not_found");
      throw new TxError("unsupported_undo");
    }
    const audit = audits.rows[0] as { entity_type: string; entity_id: string; before_state: TransactionView; after_state: TransactionView };
    const kind: TransactionKind = audit.entity_type === "manual_transaction" ? "manual" : "imported";
    const before = audit.before_state as TransactionView;
    const after = audit.after_state as TransactionView;
    const current = await readTransactionView(client, claims.workspaceId, kind, audit.entity_id);
    if (!current) throw new TxError("not_found");
    if (current.version !== after.version) throw new TxError("undo_conflict", current.version);
    // N1: undo must not resurrect archived taxonomy — restoring a category
    // or tag that has since been archived would violate the forward-path
    // liveness invariant, so the moved-on object conflicts instead.
    if (before.categoryId !== null && before.categoryId !== undefined) {
      const cat = await client.query("SELECT id FROM categories WHERE workspace_id = $1 AND id = $2 AND archived_at IS NULL", [claims.workspaceId, before.categoryId]);
      if ((cat.rowCount ?? 0) === 0) throw new TxError("undo_conflict", current.version);
    }
    if (kind === "imported") {
      for (const tagId of before.tagIds ?? []) {
        const tag = await client.query("SELECT id FROM tags WHERE workspace_id = $1 AND id = $2 AND archived_at IS NULL", [claims.workspaceId, tagId]);
        if ((tag.rowCount ?? 0) === 0) throw new TxError("undo_conflict", current.version);
      }
    }
    const table = tableFor(kind);
    const amountMinor = BigInt(before.amountMinor);
    const updated = await client.query(
      `UPDATE ${table} SET amount_minor = $1, currency = $2, direction = $3, effective_date = $4, description = $5, category_id = $6, version = version + 1, updated_at = now() WHERE workspace_id = $7 AND id = $8 AND version = $9 RETURNING version`,
      [amountMinor.toString(10), before.currency, before.direction, before.effectiveDate, before.description, before.categoryId, claims.workspaceId, audit.entity_id, current.version],
    );
    if ((updated.rowCount ?? 0) === 0) {
      const latest = await readTransactionView(client, claims.workspaceId, kind, audit.entity_id);
      throw new TxError("undo_conflict", latest?.version);
    }
    if (kind === "imported") {
      await client.query("DELETE FROM transaction_tags WHERE workspace_id = $1 AND transaction_id = $2", [claims.workspaceId, audit.entity_id]);
      for (const tagId of before.tagIds ?? []) {
        await client.query("INSERT INTO transaction_tags (workspace_id, transaction_id, tag_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [claims.workspaceId, audit.entity_id, tagId]);
      }
    }
    const restored = (await readTransactionView(client, claims.workspaceId, kind, audit.entity_id))!;
    await insertAudit(client, claims, actorId, audit.entity_type, audit.entity_id, "undo", current, restored, operationId, input.operationId);
    await bumpRevision(client, claims.workspaceId);
    return { view: restored, operationId };
  });
}

export async function undo(pool: Pool, claims: TenantClaims, actorId: string, raw: unknown): Promise<UndoResult> {
  const input = validateUndoInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => undoTx(client, claims, actorId, input));
  if (!outcome.ok) throw new TxError(outcome.code, outcome.currentVersion);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

// ---- reads ----

export async function getTransaction(pool: Pool, claims: TenantClaims, kind: TransactionKind, id: string): Promise<TransactionView | null> {
  if (!isUuid(id)) return null;
  return withTenant(pool, claims, async (client) => readTransactionView(client, claims.workspaceId, kind, id));
}

export async function listAudit(pool: Pool, claims: TenantClaims, entityType: string, entityId: string): Promise<AuditView[]> {
  if (!isUuid(entityId)) return [];
  return withTenant(pool, claims, async (client) => {
    const rows = await client.query(
      "SELECT workspace_id, id, entity_type, entity_id, action, before_state, after_state, operation_id, compensating_operation_id, created_at FROM audit_events WHERE workspace_id = $1 AND entity_type = $2 AND entity_id = $3 ORDER BY created_at",
      [claims.workspaceId, entityType, entityId],
    );
    return (rows.rows as { workspace_id: string; id: string; entity_type: string; entity_id: string; action: string; before_state: unknown; after_state: unknown; operation_id: string | null; compensating_operation_id: string | null; created_at: string }[]).map((r) => ({
      workspaceId: r.workspace_id,
      id: r.id,
      entityType: r.entity_type,
      entityId: r.entity_id,
      action: r.action,
      beforeState: r.before_state,
      afterState: r.after_state,
      operationId: r.operation_id,
      compensatingOperationId: r.compensating_operation_id,
      createdAt: r.created_at,
    }));
  });
}

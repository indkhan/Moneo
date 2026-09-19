// E01-S04 first consumed command/read contract (architecture §§47–49,
// §§60–63). One domain module, one JSON Schema source, HTTP adapter only
// (AI/artifact adapters consume this same module later). Intent-based
// `accounts.rename` with idempotency journal + optimistic versions; reads
// never mutate. Versions cross JSON strictly as decimal strings.
// E03-S01 extends with create/update, manual transactions, and balance snapshots.

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { isUuid, uuidv7 } from "../ids.ts";
import { formatDecimalBigint, parseDecimalBigint, parseMinor, parseSignedMinor, formatMinor, currencyExponent } from "../money.ts";
import { TenantDenied, TenantInvalid, withTenant, type TenantClaims } from "../tenancy.ts";

export const RENAME_COMMAND = "accounts.rename";
export const CREATE_COMMAND = "accounts.create";
export const UPDATE_COMMAND = "accounts.update";
export const MANUAL_TRANSACTION_COMMAND = "accounts.manual_transaction";
export const BALANCE_SNAPSHOT_COMMAND = "accounts.balance_snapshot";
export const BALANCE_CORRECTION_COMMAND = "accounts.balance_correction";
const REPLAY_RETENTION_DAYS = 30;

export type RenameInput = {
  workspaceId: string;
  accountId: string;
  name: string;
  expectedVersion: string;
  idempotencyKey: string;
};

export type CreateAccountInput = {
  workspaceId: string;
  name: string;
  currency: string;
  idempotencyKey: string;
};

export type UpdateAccountInput = {
  workspaceId: string;
  accountId: string;
  expectedVersion: string;
  name?: string;
  archived?: boolean;
  idempotencyKey: string;
};

export type ManualTransactionInput = {
  workspaceId: string;
  accountId: string;
  amount: string;
  currency: string;
  direction: "INFLOW" | "OUTFLOW";
  effectiveDate: string;
  description: string;
  reference?: string;
  idempotencyKey: string;
};

export type BalanceSnapshotInput = {
  workspaceId: string;
  accountId: string;
  asOfDate: string;
  amount: string;
  currency: string;
  source?: "manual" | "import" | "reconciliation";
  provenance?: Record<string, unknown>;
  freshness?: "current" | "stale" | "unknown";
  reconciliationState?: "unreconciled" | "reconciled" | "disputed";
  idempotencyKey: string;
};

export type BalanceCorrectionInput = {
  workspaceId: string;
  snapshotId: string;
  newAmount: string;
  currency: string;
  reason: string;
  idempotencyKey: string;
};

export type AccountView = {
  workspaceId: string;
  id: string;
  name: string;
  version: string;
  currency: string;
  archived: boolean;
  source: "manual" | "import";
  createdAt: string;
  updatedAt: string;
};

export type ManualTransactionView = {
  workspaceId: string;
  id: string;
  accountId: string;
  amountMinor: string;
  currency: string;
  direction: "INFLOW" | "OUTFLOW";
  effectiveDate: string;
  description: string;
  balanceSnapshotId: string | null;
  actorId: string;
  reference: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BalanceSnapshotView = {
  workspaceId: string;
  id: string;
  accountId: string;
  asOfDate: string;
  amountMinor: string;
  currency: string;
  source: "manual" | "import" | "reconciliation";
  provenance: Record<string, unknown>;
  freshness: "current" | "stale" | "unknown";
  reconciliationState: "unreconciled" | "reconciled" | "disputed";
  createdAt: string;
  updatedAt: string;
};

export type BalanceAuditView = {
  workspaceId: string;
  id: string;
  snapshotId: string;
  accountId: string;
  action: "create" | "correct" | "reconcile" | "void";
  priorAmountMinor: string | null;
  newAmountMinor: string;
  currency: string;
  reason: string;
  actorId: string;
  createdAt: string;
};

export type CommandResult = { view: AccountView; operationId: string; replayed: boolean };
export type ManualTransactionResult = { view: ManualTransactionView; operationId: string; replayed: boolean };
export type BalanceSnapshotResult = { view: BalanceSnapshotView; operationId: string; replayed: boolean };
export type BalanceCorrectionResult = { view: BalanceAuditView; operationId: string; replayed: boolean };

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
  required: ["workspaceId", "id", "name", "version", "currency", "archived", "source", "createdAt", "updatedAt"],
  properties: {
    workspaceId: { type: "string", format: "uuid" },
    id: { type: "string", format: "uuid" },
    name: { type: "string", minLength: 1, maxLength: 200 },
    version: { type: "string", pattern: "^[0-9]+$" },
    currency: { type: "string", pattern: "^[A-Z]{3}$" },
    archived: { type: "boolean" },
    source: { type: "string", enum: ["manual", "import"] },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

export const createAccountInputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://moneo.invalid/schemas/accounts.create.input",
  type: "object",
  additionalProperties: false,
  required: ["workspaceId", "name", "currency", "idempotencyKey"],
  properties: {
    workspaceId: { type: "string", format: "uuid" },
    name: { type: "string", minLength: 1, maxLength: 200 },
    currency: { type: "string", pattern: "^[A-Z]{3}$" },
    idempotencyKey: { type: "string", format: "uuid" },
  },
} as const;

export const updateAccountInputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://moneo.invalid/schemas/accounts.update.input",
  type: "object",
  additionalProperties: false,
  required: ["workspaceId", "accountId", "expectedVersion", "idempotencyKey"],
  properties: {
    workspaceId: { type: "string", format: "uuid" },
    accountId: { type: "string", format: "uuid" },
    expectedVersion: { type: "string", pattern: "^[0-9]+$" },
    name: { type: "string", minLength: 1, maxLength: 200 },
    archived: { type: "boolean" },
    idempotencyKey: { type: "string", format: "uuid" },
  },
} as const;

export const manualTransactionInputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://moneo.invalid/schemas/accounts.manual_transaction.input",
  type: "object",
  additionalProperties: false,
  required: ["workspaceId", "accountId", "amount", "currency", "direction", "effectiveDate", "description", "idempotencyKey"],
  properties: {
    workspaceId: { type: "string", format: "uuid" },
    accountId: { type: "string", format: "uuid" },
    amount: { type: "string", pattern: "^[0-9]+(\\.[0-9]+)?$" },
    currency: { type: "string", pattern: "^[A-Z]{3}$" },
    direction: { type: "string", enum: ["INFLOW", "OUTFLOW"] },
    effectiveDate: { type: "string", format: "date" },
    description: { type: "string", minLength: 1, maxLength: 500 },
    reference: { type: "string", maxLength: 200 },
    idempotencyKey: { type: "string", format: "uuid" },
  },
} as const;

export const balanceSnapshotInputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://moneo.invalid/schemas/accounts.balance_snapshot.input",
  type: "object",
  additionalProperties: false,
  required: ["workspaceId", "accountId", "asOfDate", "amount", "currency", "idempotencyKey"],
  properties: {
    workspaceId: { type: "string", format: "uuid" },
    accountId: { type: "string", format: "uuid" },
    asOfDate: { type: "string", format: "date" },
    amount: { type: "string", pattern: "^-?[0-9]+(\\.[0-9]+)?$" },
    currency: { type: "string", pattern: "^[A-Z]{3}$" },
    source: { type: "string", enum: ["manual", "import", "reconciliation"] },
    provenance: { type: "object" },
    freshness: { type: "string", enum: ["current", "stale", "unknown"] },
    reconciliationState: { type: "string", enum: ["unreconciled", "reconciled", "disputed"] },
    idempotencyKey: { type: "string", format: "uuid" },
  },
} as const;

export const balanceCorrectionInputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://moneo.invalid/schemas/accounts.balance_correction.input",
  type: "object",
  additionalProperties: false,
  required: ["workspaceId", "snapshotId", "newAmount", "currency", "reason", "idempotencyKey"],
  properties: {
    workspaceId: { type: "string", format: "uuid" },
    snapshotId: { type: "string", format: "uuid" },
    newAmount: { type: "string", pattern: "^-?[0-9]+(\\.[0-9]+)?$" },
    currency: { type: "string", pattern: "^[A-Z]{3}$" },
    reason: { type: "string", minLength: 1, maxLength: 500 },
    idempotencyKey: { type: "string", format: "uuid" },
  },
} as const;

export const manualTransactionViewSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://moneo.invalid/schemas/manual_transaction.view",
  type: "object",
  additionalProperties: false,
  required: ["workspaceId", "id", "accountId", "amountMinor", "currency", "direction", "effectiveDate", "description", "balanceSnapshotId", "actorId", "reference", "createdAt", "updatedAt"],
  properties: {
    workspaceId: { type: "string", format: "uuid" },
    id: { type: "string", format: "uuid" },
    accountId: { type: "string", format: "uuid" },
    amountMinor: { type: "string", pattern: "^[0-9]+$" },
    currency: { type: "string", pattern: "^[A-Z]{3}$" },
    direction: { type: "string", enum: ["INFLOW", "OUTFLOW"] },
    effectiveDate: { type: "string", format: "date" },
    description: { type: "string", minLength: 1, maxLength: 500 },
    balanceSnapshotId: { type: ["string", "null"], format: "uuid" },
    actorId: { type: "string", format: "uuid" },
    reference: { type: ["string", "null"], maxLength: 200 },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

export const balanceSnapshotViewSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://moneo.invalid/schemas/balance_snapshot.view",
  type: "object",
  additionalProperties: false,
  required: ["workspaceId", "id", "accountId", "asOfDate", "amountMinor", "currency", "source", "provenance", "freshness", "reconciliationState", "createdAt", "updatedAt"],
  properties: {
    workspaceId: { type: "string", format: "uuid" },
    id: { type: "string", format: "uuid" },
    accountId: { type: "string", format: "uuid" },
    asOfDate: { type: "string", format: "date" },
    amountMinor: { type: "string", pattern: "^-?[0-9]+$" },
    currency: { type: "string", pattern: "^[A-Z]{3}$" },
    source: { type: "string", enum: ["manual", "import", "reconciliation"] },
    provenance: { type: "object" },
    freshness: { type: "string", enum: ["current", "stale", "unknown"] },
    reconciliationState: { type: "string", enum: ["unreconciled", "reconciled", "disputed"] },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

export const balanceAuditViewSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://moneo.invalid/schemas/balance_audit.view",
  type: "object",
  additionalProperties: false,
  required: ["workspaceId", "id", "snapshotId", "accountId", "action", "priorAmountMinor", "newAmountMinor", "currency", "reason", "actorId", "createdAt"],
  properties: {
    workspaceId: { type: "string", format: "uuid" },
    id: { type: "string", format: "uuid" },
    snapshotId: { type: "string", format: "uuid" },
    accountId: { type: "string", format: "uuid" },
    action: { type: "string", enum: ["create", "correct", "reconcile", "void"] },
    priorAmountMinor: { type: ["string", "null"], pattern: "^-?[0-9]+$" },
    newAmountMinor: { type: "string", pattern: "^-?[0-9]+$" },
    currency: { type: "string", pattern: "^[A-Z]{3}$" },
    reason: { type: "string", minLength: 1, maxLength: 500 },
    actorId: { type: "string", format: "uuid" },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const POSITIVE_DECIMAL_RE = /^[0-9]+(\.[0-9]+)?$/;
const SIGNED_DECIMAL_RE = /^-?[0-9]+(\.[0-9]+)?$/;

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

export function validateCreateAccountInput(value: unknown): CreateAccountInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!["workspaceId", "name", "currency", "idempotencyKey"].includes(key)) throw new TenantInvalid();
  }
  const { workspaceId, name, currency, idempotencyKey } = v;
  if (typeof workspaceId !== "string" || !UUID_RE.test(workspaceId)) throw new TenantInvalid();
  if (typeof name !== "string" || name.length < 1 || name.length > 200) throw new TenantInvalid();
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) throw new TenantInvalid();
  if (currencyExponent(currency) === undefined) throw new TenantInvalid();
  if (typeof idempotencyKey !== "string" || !UUID_RE.test(idempotencyKey)) throw new TenantInvalid();
  return { workspaceId, name, currency, idempotencyKey };
}

export function validateUpdateAccountInput(value: unknown): UpdateAccountInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!["workspaceId", "accountId", "expectedVersion", "name", "archived", "idempotencyKey"].includes(key)) throw new TenantInvalid();
  }
  const { workspaceId, accountId, expectedVersion, name, archived, idempotencyKey } = v;
  if (typeof workspaceId !== "string" || !UUID_RE.test(workspaceId)) throw new TenantInvalid();
  if (typeof accountId !== "string" || !UUID_RE.test(accountId)) throw new TenantInvalid();
  if (typeof expectedVersion !== "string" || !/^[0-9]+$/.test(expectedVersion)) throw new TenantInvalid();
  if (name !== undefined && (typeof name !== "string" || name.length < 1 || name.length > 200)) throw new TenantInvalid();
  if (archived !== undefined && typeof archived !== "boolean") throw new TenantInvalid();
  if (typeof idempotencyKey !== "string" || !UUID_RE.test(idempotencyKey)) throw new TenantInvalid();
  return { workspaceId, accountId, expectedVersion, name, archived, idempotencyKey };
}

export function validateManualTransactionInput(value: unknown): ManualTransactionInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!["workspaceId", "accountId", "amount", "currency", "direction", "effectiveDate", "description", "reference", "idempotencyKey"].includes(key)) throw new TenantInvalid();
  }
  const { workspaceId, accountId, amount, currency, direction, effectiveDate, description, reference, idempotencyKey } = v;
  if (typeof workspaceId !== "string" || !UUID_RE.test(workspaceId)) throw new TenantInvalid();
  if (typeof accountId !== "string" || !UUID_RE.test(accountId)) throw new TenantInvalid();
  if (typeof amount !== "string" || !POSITIVE_DECIMAL_RE.test(amount)) throw new TenantInvalid();
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) throw new TenantInvalid();
  if (currencyExponent(currency) === undefined) throw new TenantInvalid();
  if (direction !== "INFLOW" && direction !== "OUTFLOW") throw new TenantInvalid();
  if (typeof effectiveDate !== "string" || !DATE_RE.test(effectiveDate)) throw new TenantInvalid();
  if (typeof description !== "string" || description.length < 1 || description.length > 500) throw new TenantInvalid();
  if (reference !== undefined && (typeof reference !== "string" || reference.length > 200)) throw new TenantInvalid();
  if (typeof idempotencyKey !== "string" || !UUID_RE.test(idempotencyKey)) throw new TenantInvalid();
  return { workspaceId, accountId, amount, currency, direction, effectiveDate, description, reference, idempotencyKey };
}

export function validateBalanceSnapshotInput(value: unknown): BalanceSnapshotInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!["workspaceId", "accountId", "asOfDate", "amount", "currency", "source", "provenance", "freshness", "reconciliationState", "idempotencyKey"].includes(key)) throw new TenantInvalid();
  }
  const { workspaceId, accountId, asOfDate, amount, currency, source, provenance, freshness, reconciliationState, idempotencyKey } = v;
  if (typeof workspaceId !== "string" || !UUID_RE.test(workspaceId)) throw new TenantInvalid();
  if (typeof accountId !== "string" || !UUID_RE.test(accountId)) throw new TenantInvalid();
  if (typeof asOfDate !== "string" || !DATE_RE.test(asOfDate)) throw new TenantInvalid();
  if (typeof amount !== "string" || !SIGNED_DECIMAL_RE.test(amount)) throw new TenantInvalid();
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) throw new TenantInvalid();
  if (currencyExponent(currency) === undefined) throw new TenantInvalid();
  if (source !== undefined) {
    const allowedSources = ["manual", "import", "reconciliation"] as const;
    if (!allowedSources.includes(source as "manual" | "import" | "reconciliation")) throw new TenantInvalid();
  }
  if (provenance !== undefined && (typeof provenance !== "object" || provenance === null || Array.isArray(provenance))) throw new TenantInvalid();
  if (freshness !== undefined) {
    const allowedFreshness = ["current", "stale", "unknown"] as const;
    if (!allowedFreshness.includes(freshness as "current" | "stale" | "unknown")) throw new TenantInvalid();
  }
  if (reconciliationState !== undefined) {
    const allowedRecon = ["unreconciled", "reconciled", "disputed"] as const;
    if (!allowedRecon.includes(reconciliationState as "unreconciled" | "reconciled" | "disputed")) throw new TenantInvalid();
  }
  if (typeof idempotencyKey !== "string" || !UUID_RE.test(idempotencyKey)) throw new TenantInvalid();
  return { workspaceId, accountId, asOfDate, amount, currency, source: source as "manual" | "import" | "reconciliation" | undefined, provenance: provenance as Record<string, unknown> | undefined, freshness: freshness as "current" | "stale" | "unknown" | undefined, reconciliationState: reconciliationState as "unreconciled" | "reconciled" | "disputed" | undefined, idempotencyKey };
}

export function validateBalanceCorrectionInput(value: unknown): BalanceCorrectionInput {
  if (typeof value !== "object" || value === null) throw new TenantInvalid();
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!["workspaceId", "snapshotId", "newAmount", "currency", "reason", "idempotencyKey"].includes(key)) throw new TenantInvalid();
  }
  const { workspaceId, snapshotId, newAmount, currency, reason, idempotencyKey } = v;
  if (typeof workspaceId !== "string" || !UUID_RE.test(workspaceId)) throw new TenantInvalid();
  if (typeof snapshotId !== "string" || !UUID_RE.test(snapshotId)) throw new TenantInvalid();
  if (typeof newAmount !== "string" || !SIGNED_DECIMAL_RE.test(newAmount)) throw new TenantInvalid();
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) throw new TenantInvalid();
  if (currencyExponent(currency) === undefined) throw new TenantInvalid();
  if (typeof reason !== "string" || reason.length < 1 || reason.length > 500) throw new TenantInvalid();
  if (typeof idempotencyKey !== "string" || !UUID_RE.test(idempotencyKey)) throw new TenantInvalid();
  return { workspaceId, snapshotId, newAmount, currency, reason, idempotencyKey };
}

export function requestHash(input: RenameInput): string {
  const canonical = JSON.stringify({
    accountId: input.accountId,
    expectedVersion: input.expectedVersion,
    idempotencyKey: undefined,
    name: input.name,
    workspaceId: input.workspaceId,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function createAccountRequestHash(input: CreateAccountInput): string {
  const canonical = JSON.stringify({
    name: input.name,
    currency: input.currency,
    workspaceId: input.workspaceId,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function updateAccountRequestHash(input: UpdateAccountInput): string {
  const canonical = JSON.stringify({
    accountId: input.accountId,
    expectedVersion: input.expectedVersion,
    workspaceId: input.workspaceId,
    name: input.name ?? null,
    archived: input.archived ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function manualTransactionRequestHash(input: ManualTransactionInput): string {
  const canonical = JSON.stringify({
    accountId: input.accountId,
    amount: input.amount,
    currency: input.currency,
    direction: input.direction,
    effectiveDate: input.effectiveDate,
    description: input.description,
    reference: input.reference ?? null,
    workspaceId: input.workspaceId,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function balanceSnapshotRequestHash(input: BalanceSnapshotInput): string {
  const canonical = JSON.stringify({
    accountId: input.accountId,
    asOfDate: input.asOfDate,
    amount: input.amount,
    currency: input.currency,
    source: input.source ?? "manual",
    provenance: input.provenance ?? {},
    freshness: input.freshness ?? "current",
    reconciliationState: input.reconciliationState ?? "unreconciled",
    workspaceId: input.workspaceId,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function balanceCorrectionRequestHash(input: BalanceCorrectionInput): string {
  const canonical = JSON.stringify({
    snapshotId: input.snapshotId,
    newAmount: input.newAmount,
    currency: input.currency,
    reason: input.reason,
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

function rowToView(row: { workspace_id: string; id: string; name: string; version: string; base_currency_code: string; archived: boolean; source: string; created_at: string; updated_at: string }): AccountView {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    name: row.name,
    version: formatDecimalBigint(BigInt(row.version)),
    currency: row.base_currency_code,
    archived: row.archived,
    source: row.source as "manual" | "import",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToManualTransactionView(row: { workspace_id: string; id: string; account_id: string; amount_minor: string; currency: string; direction: string; effective_date: string | Date; description: string; balance_snapshot_id: string | null; actor_id: string; reference: string | null; created_at: string; updated_at: string }): ManualTransactionView {
  const effectiveDate = row.effective_date instanceof Date
    ? `${row.effective_date.getUTCFullYear()}-${String(row.effective_date.getUTCMonth() + 1).padStart(2, "0")}-${String(row.effective_date.getUTCDate()).padStart(2, "0")}`
    : row.effective_date;
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    accountId: row.account_id,
    amountMinor: formatDecimalBigint(BigInt(row.amount_minor)),
    currency: row.currency,
    direction: row.direction as "INFLOW" | "OUTFLOW",
    effectiveDate,
    description: row.description,
    balanceSnapshotId: row.balance_snapshot_id,
    actorId: row.actor_id,
    reference: row.reference,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToBalanceSnapshotView(row: { workspace_id: string; id: string; account_id: string; as_of_date: string | Date; amount_minor: string; currency: string; source: string; provenance: Record<string, unknown>; freshness: string; reconciliation_state: string; created_at: string; updated_at: string }): BalanceSnapshotView {
  const asOfDate = row.as_of_date instanceof Date
    ? `${row.as_of_date.getUTCFullYear()}-${String(row.as_of_date.getUTCMonth() + 1).padStart(2, "0")}-${String(row.as_of_date.getUTCDate()).padStart(2, "0")}`
    : row.as_of_date;
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    accountId: row.account_id,
    asOfDate,
    amountMinor: row.amount_minor,
    currency: row.currency,
    source: row.source as "manual" | "import" | "reconciliation",
    provenance: row.provenance,
    freshness: row.freshness as "current" | "stale" | "unknown",
    reconciliationState: row.reconciliation_state as "unreconciled" | "reconciled" | "disputed",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToBalanceAuditView(row: { workspace_id: string; id: string; snapshot_id: string; account_id: string; action: string; prior_amount_minor: string | null; new_amount_minor: string; currency: string; reason: string; actor_id: string; created_at: string }): BalanceAuditView {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    snapshotId: row.snapshot_id,
    accountId: row.account_id,
    action: row.action as "create" | "correct" | "reconcile" | "void",
    priorAmountMinor: row.prior_amount_minor,
    newAmountMinor: row.new_amount_minor,
    currency: row.currency,
    reason: row.reason,
    actorId: row.actor_id,
    createdAt: row.created_at,
  };
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

export async function renameAccountTx(client: PoolClient, claims: TenantClaims, actorId: string, input: RenameInput): Promise<TxOutcome<AccountView>> {
  let expected: bigint;
  try {
    expected = parseDecimalBigint(input.expectedVersion);
  } catch {
    throw new TenantInvalid();
  }
  const hash = requestHash(input);
  return claimAndExecute(client, claims, actorId, RENAME_COMMAND, input, hash, async (client, operationId) => {
    const updated = await client.query(
      "UPDATE accounts SET name = $1, version = version + 1, updated_at = now() WHERE workspace_id = $2 AND id = $3 AND version = $4 RETURNING workspace_id, id, name, version, base_currency_code, archived, source, created_at, updated_at",
      [input.name, claims.workspaceId, input.accountId, expected.toString(10)],
    );
    if ((updated.rowCount ?? 0) === 0) {
      const current = await client.query("SELECT version FROM accounts WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, input.accountId]);
      if ((current.rowCount ?? 0) === 0) throw new CommandError("not_found");
      throw new CommandError("version_mismatch", formatDecimalBigint(BigInt((current.rows[0] as { version: string }).version)));
    }
    const view = rowToView(updated.rows[0] as { workspace_id: string; id: string; name: string; version: string; base_currency_code: string; archived: boolean; source: string; created_at: string; updated_at: string });
    return { view, operationId };
  });
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
  const outcome = await withTenant(pool, claims, (client) => renameAccountTx(client, claims, actorId, input));
  if (!outcome.ok) throw new CommandError(outcome.code, outcome.currentVersion);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

export async function createAccountTx(client: PoolClient, claims: TenantClaims, actorId: string, input: CreateAccountInput): Promise<TxOutcome<AccountView>> {
  const hash = createAccountRequestHash(input);
  return claimAndExecute(client, claims, actorId, CREATE_COMMAND, input, hash, async (client, operationId) => {
    const id = uuidv7();
    const rows = await client.query(
      "INSERT INTO accounts (workspace_id, id, name, base_currency_code, source) VALUES ($1, $2, $3, $4, 'manual') RETURNING workspace_id, id, name, version, base_currency_code, archived, source, created_at, updated_at",
      [claims.workspaceId, id, input.name, input.currency],
    );
    const view = rowToView(rows.rows[0] as { workspace_id: string; id: string; name: string; version: string; base_currency_code: string; archived: boolean; source: string; created_at: string; updated_at: string });
    return { view, operationId };
  });
}

export async function createAccount(
  pool: Parameters<typeof withTenant>[0],
  claims: TenantClaims,
  actorId: string,
  raw: unknown,
): Promise<CommandResult> {
  const input = validateCreateAccountInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => createAccountTx(client, claims, actorId, input));
  if (!outcome.ok) throw new CommandError(outcome.code, outcome.currentVersion);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

export async function updateAccountTx(client: PoolClient, claims: TenantClaims, actorId: string, input: UpdateAccountInput): Promise<TxOutcome<AccountView>> {
  let expected: bigint;
  try {
    expected = parseDecimalBigint(input.expectedVersion);
  } catch {
    throw new TenantInvalid();
  }
  const hash = updateAccountRequestHash(input);
  return claimAndExecute(client, claims, actorId, UPDATE_COMMAND, input, hash, async (client, operationId) => {
    const setParts: string[] = ["version = version + 1", "updated_at = now()"];
    const params: unknown[] = [claims.workspaceId, input.accountId, expected.toString(10)];
    let paramIdx = 4;
    if (input.name !== undefined) {
      setParts.push(`name = $${paramIdx++}`);
      params.push(input.name);
    }
    if (input.archived !== undefined) {
      setParts.push(`archived = $${paramIdx++}`);
      params.push(input.archived);
    }
    const sql = `UPDATE accounts SET ${setParts.join(", ")} WHERE workspace_id = $1 AND id = $2 AND version = $3 RETURNING workspace_id, id, name, version, base_currency_code, archived, source, created_at, updated_at`;
    const updated = await client.query(sql, params);
    if ((updated.rowCount ?? 0) === 0) {
      const current = await client.query("SELECT version FROM accounts WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, input.accountId]);
      if ((current.rowCount ?? 0) === 0) throw new CommandError("not_found");
      throw new CommandError("version_mismatch", formatDecimalBigint(BigInt((current.rows[0] as { version: string }).version)));
    }
    const view = rowToView(updated.rows[0] as { workspace_id: string; id: string; name: string; version: string; base_currency_code: string; archived: boolean; source: string; created_at: string; updated_at: string });
    return { view, operationId };
  });
}

export async function updateAccount(
  pool: Parameters<typeof withTenant>[0],
  claims: TenantClaims,
  actorId: string,
  raw: unknown,
): Promise<CommandResult> {
  const input = validateUpdateAccountInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  if (!isUuid(input.accountId)) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => updateAccountTx(client, claims, actorId, input));
  if (!outcome.ok) throw new CommandError(outcome.code, outcome.currentVersion);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

export async function manualTransactionTx(client: PoolClient, claims: TenantClaims, actorId: string, input: ManualTransactionInput): Promise<TxOutcome<ManualTransactionView>> {
  // Money parse failures are malformed input (400 via TenantInvalid), never
  // a 503: parse before claiming any journal row so retries stay safe.
  let amountMinor: bigint;
  try {
    amountMinor = parseMinor(input.amount, input.currency);
  } catch {
    throw new TenantInvalid();
  }
  const hash = manualTransactionRequestHash(input);
  return claimAndExecute(client, claims, actorId, MANUAL_TRANSACTION_COMMAND, input, hash, async (client, operationId) => {
    const id = uuidv7();
    const rows = await client.query(
      `INSERT INTO manual_transactions (workspace_id, id, account_id, amount_minor, currency, direction, effective_date, description, actor_id, reference)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING workspace_id, id, account_id, amount_minor, currency, direction, effective_date, description, balance_snapshot_id, actor_id, reference, created_at, updated_at`,
      [claims.workspaceId, id, input.accountId, amountMinor.toString(), input.currency, input.direction, input.effectiveDate, input.description, actorId, input.reference ?? null],
    );
    const view = rowToManualTransactionView(rows.rows[0] as { workspace_id: string; id: string; account_id: string; amount_minor: string; currency: string; direction: string; effective_date: string; description: string; balance_snapshot_id: string | null; actor_id: string; reference: string | null; created_at: string; updated_at: string });
    return { view, operationId };
  });
}

export async function manualTransaction(
  pool: Parameters<typeof withTenant>[0],
  claims: TenantClaims,
  actorId: string,
  raw: unknown,
): Promise<ManualTransactionResult> {
  const input = validateManualTransactionInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  if (!isUuid(input.accountId)) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => manualTransactionTx(client, claims, actorId, input));
  if (!outcome.ok) throw new CommandError(outcome.code, outcome.currentVersion);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

export async function balanceSnapshotTx(client: PoolClient, claims: TenantClaims, actorId: string, input: BalanceSnapshotInput): Promise<TxOutcome<BalanceSnapshotView>> {
  let amountMinor: bigint;
  try {
    amountMinor = parseSignedMinor(input.amount, input.currency);
  } catch {
    throw new TenantInvalid();
  }
  const hash = balanceSnapshotRequestHash(input);
  return claimAndExecute(client, claims, actorId, BALANCE_SNAPSHOT_COMMAND, input, hash, async (client, operationId) => {
    const account = await client.query("SELECT base_currency_code FROM accounts WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, input.accountId]);
    if ((account.rowCount ?? 0) === 0) throw new CommandError("not_found");
    const accountCurrency = (account.rows[0] as { base_currency_code: string }).base_currency_code;
    if (accountCurrency !== input.currency) throw new CommandError("version_mismatch");

    const id = uuidv7();
    const rows = await client.query(
      `INSERT INTO balance_snapshots (workspace_id, id, account_id, as_of_date, amount_minor, currency, source, provenance, freshness, reconciliation_state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (workspace_id, account_id, as_of_date) DO UPDATE SET
         amount_minor = EXCLUDED.amount_minor,
         currency = EXCLUDED.currency,
         source = EXCLUDED.source,
         provenance = EXCLUDED.provenance,
         freshness = EXCLUDED.freshness,
         reconciliation_state = EXCLUDED.reconciliation_state,
         updated_at = now()
       RETURNING workspace_id, id, account_id, as_of_date, amount_minor, currency, source, provenance, freshness, reconciliation_state, created_at, updated_at`,
      [
        claims.workspaceId, id, input.accountId, input.asOfDate, amountMinor.toString(), input.currency,
        input.source ?? "manual", JSON.stringify(input.provenance ?? {}), input.freshness ?? "current", input.reconciliationState ?? "unreconciled"
      ],
    );
    const view = rowToBalanceSnapshotView(rows.rows[0] as { workspace_id: string; id: string; account_id: string; as_of_date: string; amount_minor: string; currency: string; source: string; provenance: Record<string, unknown>; freshness: string; reconciliation_state: string; created_at: string; updated_at: string });

    const auditId = uuidv7();
    await client.query(
      `INSERT INTO balance_audit (workspace_id, id, snapshot_id, account_id, action, prior_amount_minor, new_amount_minor, currency, reason, actor_id)
       VALUES ($1, $2, $3, $4, 'create', NULL, $5, $6, $7, $8)`,
      [claims.workspaceId, auditId, view.id, input.accountId, view.amountMinor, input.currency, `Initial balance entry`, actorId],
    );

    return { view, operationId };
  });
}

export async function balanceSnapshot(
  pool: Parameters<typeof withTenant>[0],
  claims: TenantClaims,
  actorId: string,
  raw: unknown,
): Promise<BalanceSnapshotResult> {
  const input = validateBalanceSnapshotInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  if (!isUuid(input.accountId)) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => balanceSnapshotTx(client, claims, actorId, input));
  if (!outcome.ok) throw new CommandError(outcome.code, outcome.currentVersion);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

export async function balanceCorrectionTx(client: PoolClient, claims: TenantClaims, actorId: string, input: BalanceCorrectionInput): Promise<TxOutcome<BalanceAuditView>> {
  let newAmountMinor: bigint;
  try {
    newAmountMinor = parseMinor(input.newAmount, input.currency);
  } catch {
    throw new TenantInvalid();
  }
  const hash = balanceCorrectionRequestHash(input);
  return claimAndExecute(client, claims, actorId, BALANCE_CORRECTION_COMMAND, input, hash, async (client, operationId) => {
    const snapshot = await client.query("SELECT workspace_id, id, account_id, amount_minor, currency FROM balance_snapshots WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, input.snapshotId]);
    if ((snapshot.rowCount ?? 0) === 0) throw new CommandError("not_found");
    const snap = snapshot.rows[0] as { workspace_id: string; id: string; account_id: string; amount_minor: string; currency: string };
    if (snap.currency !== input.currency) throw new CommandError("version_mismatch");

    const priorAmountMinor = snap.amount_minor;

    const updated = await client.query(
      `UPDATE balance_snapshots SET amount_minor = $1, currency = $2, updated_at = now()
       WHERE workspace_id = $3 AND id = $4
       RETURNING workspace_id, id, account_id, as_of_date, amount_minor, currency, source, provenance, freshness, reconciliation_state, created_at, updated_at`,
      [newAmountMinor.toString(), input.currency, claims.workspaceId, input.snapshotId],
    );
    const view = rowToBalanceSnapshotView(updated.rows[0] as { workspace_id: string; id: string; account_id: string; as_of_date: string; amount_minor: string; currency: string; source: string; provenance: Record<string, unknown>; freshness: string; reconciliation_state: string; created_at: string; updated_at: string });

    const auditId = uuidv7();
    await client.query(
      `INSERT INTO balance_audit (workspace_id, id, snapshot_id, account_id, action, prior_amount_minor, new_amount_minor, currency, reason, actor_id)
       VALUES ($1, $2, $3, $4, 'correct', $5, $6, $7, $8, $9)`,
      [claims.workspaceId, auditId, input.snapshotId, snap.account_id, priorAmountMinor, view.amountMinor, input.currency, input.reason, actorId],
    );

    const auditView: BalanceAuditView = {
      workspaceId: claims.workspaceId,
      id: auditId,
      snapshotId: input.snapshotId,
      accountId: snap.account_id,
      action: "correct",
      priorAmountMinor,
      newAmountMinor: view.amountMinor,
      currency: input.currency,
      reason: input.reason,
      actorId,
      createdAt: new Date().toISOString(),
    };
    return { view: auditView, operationId };
  });
}

export async function balanceCorrection(
  pool: Parameters<typeof withTenant>[0],
  claims: TenantClaims,
  actorId: string,
  raw: unknown,
): Promise<BalanceCorrectionResult> {
  const input = validateBalanceCorrectionInput(raw);
  if (input.workspaceId !== claims.workspaceId) throw new TenantDenied();
  if (!isUuid(input.snapshotId)) throw new TenantDenied();
  const outcome = await withTenant(pool, claims, (client) => balanceCorrectionTx(client, claims, actorId, input));
  if (!outcome.ok) throw new CommandError(outcome.code, outcome.currentVersion);
  return { view: outcome.result, operationId: outcome.operationId, replayed: outcome.replayed };
}

export async function getAccountView(pool: Parameters<typeof withTenant>[0], claims: TenantClaims, accountId: string): Promise<AccountView | null> {
  if (!isUuid(accountId)) return null;
  return withTenant(pool, claims, async (client) => {
    const rows = await client.query("SELECT workspace_id, id, name, version, base_currency_code, archived, source, created_at, updated_at FROM accounts WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, accountId]);
    if ((rows.rowCount ?? 0) === 0) return null;
    return rowToView(rows.rows[0] as { workspace_id: string; id: string; name: string; version: string; base_currency_code: string; archived: boolean; source: string; created_at: string; updated_at: string });
  });
}

export async function listAccountViews(pool: Parameters<typeof withTenant>[0], claims: TenantClaims): Promise<AccountView[]> {
  return withTenant(pool, claims, async (client) => {
    const rows = await client.query("SELECT workspace_id, id, name, version, base_currency_code, archived, source, created_at, updated_at FROM accounts WHERE workspace_id = $1 ORDER BY created_at", [claims.workspaceId]);
    return (rows.rows as { workspace_id: string; id: string; name: string; version: string; base_currency_code: string; archived: boolean; source: string; created_at: string; updated_at: string }[]).map(rowToView);
  });
}

export async function listManualTransactions(pool: Parameters<typeof withTenant>[0], claims: TenantClaims, accountId: string, limit = 100, offset = 0): Promise<ManualTransactionView[]> {
  if (!isUuid(accountId)) return [];
  return withTenant(pool, claims, async (client) => {
    const account = await client.query("SELECT 1 FROM accounts WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, accountId]);
    if ((account.rowCount ?? 0) === 0) return [];
    const rows = await client.query(
      "SELECT workspace_id, id, account_id, amount_minor, currency, direction, effective_date, description, balance_snapshot_id, actor_id, reference, created_at, updated_at FROM manual_transactions WHERE workspace_id = $1 AND account_id = $2 ORDER BY effective_date DESC, created_at DESC LIMIT $3 OFFSET $4",
      [claims.workspaceId, accountId, limit, offset],
    );
    return (rows.rows as { workspace_id: string; id: string; account_id: string; amount_minor: string; currency: string; direction: string; effective_date: string; description: string; balance_snapshot_id: string | null; actor_id: string; reference: string | null; created_at: string; updated_at: string }[]).map(rowToManualTransactionView);
  });
}

export async function listBalanceSnapshots(pool: Parameters<typeof withTenant>[0], claims: TenantClaims, accountId: string, limit = 100, offset = 0): Promise<BalanceSnapshotView[]> {
  if (!isUuid(accountId)) return [];
  return withTenant(pool, claims, async (client) => {
    const account = await client.query("SELECT 1 FROM accounts WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, accountId]);
    if ((account.rowCount ?? 0) === 0) return [];
    const rows = await client.query(
      "SELECT workspace_id, id, account_id, as_of_date, amount_minor, currency, source, provenance, freshness, reconciliation_state, created_at, updated_at FROM balance_snapshots WHERE workspace_id = $1 AND account_id = $2 ORDER BY as_of_date DESC LIMIT $3 OFFSET $4",
      [claims.workspaceId, accountId, limit, offset],
    );
    return (rows.rows as { workspace_id: string; id: string; account_id: string; as_of_date: string; amount_minor: string; currency: string; source: string; provenance: Record<string, unknown>; freshness: string; reconciliation_state: string; created_at: string; updated_at: string }[]).map(rowToBalanceSnapshotView);
  });
}

export async function getBalanceSnapshot(pool: Parameters<typeof withTenant>[0], claims: TenantClaims, snapshotId: string): Promise<BalanceSnapshotView | null> {
  if (!isUuid(snapshotId)) return null;
  return withTenant(pool, claims, async (client) => {
    const rows = await client.query(
      "SELECT workspace_id, id, account_id, as_of_date, amount_minor, currency, source, provenance, freshness, reconciliation_state, created_at, updated_at FROM balance_snapshots WHERE workspace_id = $1 AND id = $2",
      [claims.workspaceId, snapshotId],
    );
    if ((rows.rowCount ?? 0) === 0) return null;
    return rowToBalanceSnapshotView(rows.rows[0] as { workspace_id: string; id: string; account_id: string; as_of_date: string; amount_minor: string; currency: string; source: string; provenance: Record<string, unknown>; freshness: string; reconciliation_state: string; created_at: string; updated_at: string });
  });
}

export async function listBalanceAudit(pool: Parameters<typeof withTenant>[0], claims: TenantClaims, snapshotId: string): Promise<BalanceAuditView[]> {
  if (!isUuid(snapshotId)) return [];
  return withTenant(pool, claims, async (client) => {
    const rows = await client.query(
      "SELECT workspace_id, id, snapshot_id, account_id, action, prior_amount_minor, new_amount_minor, currency, reason, actor_id, created_at FROM balance_audit WHERE workspace_id = $1 AND snapshot_id = $2 ORDER BY created_at",
      [claims.workspaceId, snapshotId],
    );
    return (rows.rows as { workspace_id: string; id: string; snapshot_id: string; account_id: string; action: string; prior_amount_minor: string | null; new_amount_minor: string; currency: string; reason: string; actor_id: string; created_at: string }[]).map(rowToBalanceAuditView);
  });
}
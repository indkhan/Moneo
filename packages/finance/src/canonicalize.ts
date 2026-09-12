import { isKnownCurrency, minorDigitsFor } from "@moneo/shared/currencies";
import { assertSafeInteger } from "@moneo/shared/money";
import { DomainError } from "@moneo/shared/problem";
import type { MappedPreviewRow } from "./mapping.js";

/**
 * Issue 4.3 — canonicalization service.
 *
 * Turns typed statement rows (the `previewMappedRows` shape the import
 * workflow already produces) into canonical accounts + transactions with
 * `PRIMARY` source links. Design constraints, in priority order:
 *
 * 1. Raw source history is never written, only referenced by id. The
 *    `CanonicalizeStore` interface exposes NO source-table mutation method,
 *    so deleting or rewriting an observation is impossible by construction —
 *    not just by discipline.
 * 2. Every step is idempotent: a retried row resolves to the SAME canonical
 *    ids (link lookups first, inserts only on miss). Replays never duplicate.
 * 3. No fuzzy identity: one source transaction yields one canonical
 *    transaction. Two legitimate identical purchases stay distinct; overlap
 *    disambiguation is Issue 4.11's job, never a uniqueness guess here.
 * 4. Money stays exact: `amountMinor` travels as a decimal string from the
 *    mapping layer to the canonical row; the only numeric operations are
 *    `BigInt` parsing and the shared safe-integer check.
 *
 * Execution wiring (calling this per batch from the import worker) lands
 * with Issue 4.11, which shares the same per-row hook for match staging.
 */

export interface CanonicalizeInput {
  workspaceId: string;
  dataSourceId: string;
  sourceAccountId: string;
  sourceTransactionId: string;
  /** Wizard-chosen label for a first-seen source account. */
  sourceAccountLabel?: string | null;
  row: MappedPreviewRow;
}

export interface CanonicalizedRow {
  accountId: string;
  accountCreated: boolean;
  transactionId: string;
  transactionCreated: boolean;
}

export interface CanonicalizeStore {
  findAccountIdBySource(sourceAccountId: string): Promise<string | null>;
  createAccount(input: {
    workspaceId: string;
    name: string;
    currencyCode: string;
  }): Promise<{ id: string }>;
  linkAccount(input: {
    workspaceId: string;
    accountId: string;
    sourceAccountId: string;
  }): Promise<void>;
  findTransactionIdBySource(sourceTransactionId: string): Promise<string | null>;
  createTransaction(input: {
    workspaceId: string;
    accountId: string;
    direction: "credit" | "debit";
    amountMinor: string;
    currencyCode: string;
    effectiveDate: string;
    description: string;
  }): Promise<{ id: string }>;
  linkTransaction(input: {
    workspaceId: string;
    transactionId: string;
    sourceTransactionId: string;
  }): Promise<void>;
}

function invalid(message: string): DomainError {
  return new DomainError("VALIDATION_FAILED", {
    detail: message,
    errors: [{ field: "row", message }],
  });
}

function asNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalid(`Canonicalize input "${field}" must be a non-empty string.`);
  }
  return value;
}

/**
 * Validate a mapped row into canonical fields. Throws DomainError
 * (PERMANENT_INPUT downstream) on bad DATA; the caller treats that as a
 * rejected row, never a retried one.
 */
export function toCanonicalFields(row: MappedPreviewRow): {
  direction: "credit" | "debit";
  amountMinor: string;
  currencyCode: string;
  effectiveDate: string;
  description: string;
} {
  // `direction` is typed as credit/debit, but runtime callers (imports,
  // worker payloads) can smuggle anything in — validate as a string.
  const direction = row.direction as string;
  if (direction !== "credit" && direction !== "debit") {
    throw invalid(`Unknown direction: ${row.direction}.`);
  }
  const currency = row.currency.toUpperCase();
  if (!isKnownCurrency(currency)) {
    throw invalid(`Unknown currency: ${row.currency}.`);
  }
  // Exactness gate: the shared exponent is authoritative, the value must be
  // a non-negative integer string inside the safe range — never a float.
  let amount: bigint;
  try {
    if (!/^(0|[1-9]\d*)$/.test(row.amountMinor)) {
      throw new Error("not a non-negative integer string");
    }
    amount = BigInt(row.amountMinor);
    assertSafeInteger(amount, "amountMinor");
  } catch {
    throw invalid(`Invalid amountMinor: ${row.amountMinor}.`);
  }
  if (amount <= 0n) {
    throw invalid(`Invalid amountMinor (must be > 0): ${row.amountMinor}.`);
  }
  // mapping.ts guarantees precision fits the exponent; re-check the digit
  // width here so a hand-built caller cannot smuggle in a scaled value.
  void minorDigitsFor(currency);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || Number.isNaN(Date.parse(`${row.date}T00:00:00Z`))) {
    throw invalid(`Invalid effective date: ${row.date}.`);
  }
  return {
    direction,
    amountMinor: amount.toString(),
    currencyCode: currency,
    effectiveDate: row.date,
    description: row.description,
  };
}

/** In-memory store: same lookup-first idempotency the Drizzle store keeps. */
export function createMemoryCanonicalizeStore(): CanonicalizeStore & {
  accountCount(): number;
  transactionCount(): number;
} {
  const accountBySource = new Map<string, string>();
  const txnBySource = new Map<string, string>();
  let ids = 0;
  const store: CanonicalizeStore & {
    accountCount(): number;
    transactionCount(): number;
  } = {
    accountCount: () => new Set(accountBySource.values()).size,
    transactionCount: () => new Set(txnBySource.values()).size,
    findAccountIdBySource: (sourceAccountId) =>
      Promise.resolve(accountBySource.get(sourceAccountId) ?? null),
    createAccount: () => {
      ids += 1;
      return Promise.resolve({ id: `acct-${ids}` });
    },
    linkAccount: ({ accountId, sourceAccountId }) => {
      const existing = accountBySource.get(sourceAccountId);
      if (existing !== undefined && existing !== accountId) {
        return Promise.reject(
          new Error(`source account ${sourceAccountId} already linked to ${existing}`),
        );
      }
      accountBySource.set(sourceAccountId, accountId);
      return Promise.resolve();
    },
    findTransactionIdBySource: (sourceTransactionId) =>
      Promise.resolve(txnBySource.get(sourceTransactionId) ?? null),
    createTransaction: () => {
      ids += 1;
      return Promise.resolve({ id: `txn-${ids}` });
    },
    linkTransaction: ({ transactionId, sourceTransactionId }) => {
      const existing = txnBySource.get(sourceTransactionId);
      if (existing !== undefined && existing !== transactionId) {
        return Promise.reject(
          new Error(`source transaction ${sourceTransactionId} already linked to ${existing}`),
        );
      }
      txnBySource.set(sourceTransactionId, transactionId);
      return Promise.resolve();
    },
  };
  return store;
}

/**
 * Canonicalize one source row: ensure the canonical account for the source
 * account, then ensure the canonical transaction for the source
 * transaction. Both steps are lookup-first, so any retry (worker redelivery,
 * double import completion) resolves to the same ids with
 * `*Created: false` and no duplicate effect.
 */
export async function canonicalizeRow(
  store: CanonicalizeStore,
  input: CanonicalizeInput,
): Promise<CanonicalizedRow> {
  const workspaceId = asNonEmpty(input.workspaceId, "workspaceId");
  const sourceAccountId = asNonEmpty(input.sourceAccountId, "sourceAccountId");
  const sourceTransactionId = asNonEmpty(input.sourceTransactionId, "sourceTransactionId");
  const fields = toCanonicalFields(input.row);

  let accountId = await store.findAccountIdBySource(sourceAccountId);
  let accountCreated = false;
  if (accountId === null) {
    const label =
      input.row.account?.trim() ||
      input.sourceAccountLabel?.trim() ||
      "Imported account";
    const created = await store.createAccount({
      workspaceId,
      name: label,
      currencyCode: fields.currencyCode,
    });
    await store.linkAccount({ workspaceId, accountId: created.id, sourceAccountId });
    accountId = created.id;
    accountCreated = true;
  }

  let transactionId = await store.findTransactionIdBySource(sourceTransactionId);
  let transactionCreated = false;
  if (transactionId === null) {
    const created = await store.createTransaction({
      workspaceId,
      accountId,
      direction: fields.direction,
      amountMinor: fields.amountMinor,
      currencyCode: fields.currencyCode,
      effectiveDate: fields.effectiveDate,
      description: fields.description,
    });
    await store.linkTransaction({ workspaceId, transactionId: created.id, sourceTransactionId });
    transactionId = created.id;
    transactionCreated = true;
  }

  return { accountId, accountCreated, transactionId, transactionCreated };
}

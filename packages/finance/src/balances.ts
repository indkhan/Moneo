import { isKnownCurrency } from "@moneo/shared/currencies";
import { assertSafeInteger } from "@moneo/shared/money";
import { DomainError } from "@moneo/shared/problem";
import { CommandError, type CommandDefinition, type CommandMutation } from "./commands.js";

/**
 * Issue 4.10 — balance reconciliation domain (pure, no I/O).
 *
 * Inclusion contract: a snapshot covers every transaction with
 * `effectiveDate < cutoffDate`; roll-forward applies `>= cutoffDate`
 * exactly once. A NULL cutoff means unknown inclusion — reconciliation
 * stays unresolved instead of guessing. Same-day ambiguity is resolved by
 * the date rule alone (midnight precision is all statements promise); rows
 * the rule cannot classify do not exist by construction.
 *
 * `accounts.recordBalance` is insert-only: corrections supersede by
 * inserting a newer snapshot, never by updating. Entity versions arrive
 * with Issue 5.2; until then concurrency rides on idempotency keys plus a
 * duplicate check in loadState, so retries converge instead of doubling.
 */

export type BalanceSnapshotSource = "statement" | "manual" | "imported" | "other";

export interface BalanceSnapshotLike {
  observedAt: string;
  currentAmountMinor: string | null;
  availableAmountMinor: string | null;
  currencyCode: string;
  source: BalanceSnapshotSource;
  cutoffDate: string | null;
}

export interface ReconcilableTransaction {
  id: string;
  effectiveDate: string;
  direction: "credit" | "debit";
  amountMinor: string;
  currencyCode: string;
}

export type UnresolvedReason = "no-cutoff" | "no-snapshot-amount" | "mixed-currency" | "truncated";

export interface ReconciliationPreview {
  applicableCount: number;
  skippedCrossCurrency: number;
  projectedCurrentMinor: string | null;
  unresolved: boolean;
  reason: UnresolvedReason | null;
  truncated: boolean;
}

function invalid(message: string): DomainError {
  return new DomainError("VALIDATION_FAILED", {
    detail: message,
    errors: [{ field: "balance", message }],
  });
}

function checkMinor(value: string | null, field: string, allowNegative = false): bigint | null {
  if (value === null) {
    return null;
  }
  const pattern = allowNegative ? /^-?(0|[1-9]\d*)$/ : /^(0|[1-9]\d*)$/;
  if (!pattern.test(value)) {
    throw invalid(
      `Invalid ${field} (expected ${allowNegative ? "signed" : "non-negative"} integer string): ${value}.`,
    );
  }
  const amount = BigInt(value);
  assertSafeInteger(amount, field);
  return amount;
}

function checkIsoDateTime(value: string, field: string): string {
  if (Number.isNaN(Date.parse(value))) {
    throw invalid(`Invalid ${field} (expected ISO datetime): ${value}.`);
  }
  return value;
}

function checkIsoDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw invalid(`Invalid ${field} (expected YYYY-MM-DD): ${value}.`);
  }
  return value;
}

/**
 * Project a snapshot forward over later transactions. Same-currency rows on
 * or after the cutoff apply once (credit adds, debit subtracts);
 * cross-currency rows cannot be applied without a valuation, so any one of
 * them marks the projection unresolved rather than silently skipped.
 */
export function previewReconciliation(
  snapshot: BalanceSnapshotLike | null,
  txns: readonly ReconcilableTransaction[],
  options: { truncated?: boolean } = {},
): ReconciliationPreview {
  const truncated = options.truncated ?? false;
  if (!snapshot) {
    return {
      applicableCount: 0,
      skippedCrossCurrency: 0,
      projectedCurrentMinor: null,
      unresolved: true,
      reason: "no-snapshot-amount",
      truncated,
    };
  }
  const current = checkMinor(snapshot.currentAmountMinor, "currentAmountMinor", true);
  if (current === null) {
    return {
      applicableCount: 0,
      skippedCrossCurrency: 0,
      projectedCurrentMinor: null,
      unresolved: true,
      reason: "no-snapshot-amount",
      truncated,
    };
  }
  if (snapshot.cutoffDate === null) {
    return {
      applicableCount: 0,
      skippedCrossCurrency: 0,
      projectedCurrentMinor: null,
      unresolved: true,
      reason: "no-cutoff",
      truncated,
    };
  }
  checkIsoDate(snapshot.cutoffDate, "cutoffDate");
  let projected = current;
  let applicableCount = 0;
  let skippedCrossCurrency = 0;
  for (const txn of txns) {
    if (txn.effectiveDate < snapshot.cutoffDate) {
      continue;
    }
    if (txn.currencyCode.toUpperCase() !== snapshot.currencyCode.toUpperCase()) {
      skippedCrossCurrency += 1;
      continue;
    }
    const amount = checkMinor(txn.amountMinor, "transaction.amountMinor");
    if (amount === null || amount <= 0n) {
      throw invalid(`Invalid transaction amount: ${txn.amountMinor}.`);
    }
    projected = txn.direction === "credit" ? projected + amount : projected - amount;
    applicableCount += 1;
  }
  if (skippedCrossCurrency > 0 || truncated) {
    return {
      applicableCount,
      skippedCrossCurrency,
      projectedCurrentMinor: null,
      unresolved: true,
      reason: truncated ? "truncated" : "mixed-currency",
      truncated,
    };
  }
  assertSafeInteger(projected, "projected balance");
  return {
    applicableCount,
    skippedCrossCurrency: 0,
    projectedCurrentMinor: projected.toString(),
    unresolved: false,
    reason: null,
    truncated: false,
  };
}

export type BalanceState = "unknown" | "ok" | "unreconciled" | "conflict";

/**
 * Coverage state for one account's snapshot history (newest observedAt
 * wins). Unknown: no snapshot. Conflict: two snapshots share the newest
 * observedAt with different values — a newer superseding entry is required.
 * Unreconciled: the winning snapshot has no cutoff. Otherwise ok.
 */
export function balanceStateFor(snapshots: readonly BalanceSnapshotLike[]): BalanceState {
  if (snapshots.length === 0) {
    return "unknown";
  }
  let latest = snapshots[0];
  if (!latest) {
    return "unknown";
  }
  for (const snapshot of snapshots.slice(1)) {
    if (snapshot.observedAt > latest.observedAt) {
      latest = snapshot;
    }
  }
  const contenders = snapshots.filter((s) => s.observedAt === latest.observedAt);
  const disagreeing = contenders.filter(
    (s) =>
      s.currentAmountMinor !== latest.currentAmountMinor ||
      s.availableAmountMinor !== latest.availableAmountMinor ||
      s.cutoffDate !== latest.cutoffDate,
  );
  if (disagreeing.length > 0) {
    return "conflict";
  }
  if (latest.cutoffDate === null) {
    return "unreconciled";
  }
  return "ok";
}

export interface RecordBalanceInput {
  accountId: string;
  observedAt: string;
  currentAmountMinor: string | null;
  availableAmountMinor?: string | null;
  currencyCode: string;
  source: BalanceSnapshotSource;
  cutoffDate: string | null;
  sourceImportId?: string | null;
}

export interface RecordBalanceResult {
  snapshotId: string;
  accountId: string;
  /** True when an older snapshot already existed (this one supersedes it). */
  superseded: boolean;
  /** True when the row already existed (retry convergence, no new write). */
  duplicate: boolean;
}

interface LoadedBalanceState {
  workspaceId: string;
  account: { id: string; currencyCode: string } | null;
  latestExists: boolean;
  duplicateId: string | null;
}

export interface RecordBalanceData {
  findAccount(
    workspaceId: string,
    accountId: string,
  ): Promise<{
    id: string;
    currencyCode: string;
  } | null>;
  latestExists(workspaceId: string, accountId: string): Promise<boolean>;
  findDuplicate(workspaceId: string, input: RecordBalanceInput): Promise<{ id: string } | null>;
  insertSnapshot(workspaceId: string, input: RecordBalanceInput): Promise<{ id: string }>;
}

function commandFail(message: string): never {
  throw new CommandError("INVARIANT_VIOLATION", message);
}

/** `accounts.recordBalance`: audited, idempotent, insert-only snapshot entry. */
export function createRecordBalanceCommand(
  data: RecordBalanceData,
): CommandDefinition<LoadedBalanceState, RecordBalanceInput, RecordBalanceResult> {
  return {
    name: "accounts.recordBalance",
    authorize: () => {},
    async loadState(ctx, input) {
      const account = await data.findAccount(ctx.workspaceId, input.accountId);
      return {
        workspaceId: ctx.workspaceId,
        account,
        latestExists: account ? await data.latestExists(ctx.workspaceId, account.id) : false,
        duplicateId: account
          ? ((await data.findDuplicate(ctx.workspaceId, input))?.id ?? null)
          : null,
      };
    },
    currentVersionOf: () => null,
    checkInvariant(state, input) {
      if (!state.account) {
        throw new CommandError("FORBIDDEN", "Account not found in this workspace.");
      }
      if (!["statement", "manual", "imported", "other"].includes(input.source)) {
        commandFail(`Unknown balance source: ${input.source}.`);
      }
      checkIsoDateTime(input.observedAt, "observedAt");
      const currency = input.currencyCode.toUpperCase();
      if (!isKnownCurrency(currency)) {
        commandFail(`Unknown currency: ${input.currencyCode}.`);
      }
      if (currency !== state.account.currencyCode.toUpperCase()) {
        commandFail(
          `Snapshot currency ${currency} must match account currency ${state.account.currencyCode}.`,
        );
      }
      checkMinor(input.currentAmountMinor, "currentAmountMinor", true);
      checkMinor(input.availableAmountMinor ?? null, "availableAmountMinor", true);
      if (input.cutoffDate !== null) {
        checkIsoDate(input.cutoffDate, "cutoffDate");
      }
    },
    async mutate(state, input): Promise<CommandMutation<RecordBalanceResult>> {
      const account = state.account;
      if (!account) {
        throw new CommandError("FORBIDDEN", "Account not found in this workspace.");
      }
      if (state.duplicateId) {
        return {
          resultingVersion: 0,
          result: {
            snapshotId: state.duplicateId,
            accountId: account.id,
            superseded: state.latestExists,
            duplicate: true,
          },
          audit: {
            entityType: "account",
            entityId: account.id,
            action: "accounts.recordBalance",
            oldValue: null,
            newValue: { snapshotId: state.duplicateId, duplicate: true },
          },
        };
      }
      const created = await data.insertSnapshot(state.workspaceId, input);
      return {
        resultingVersion: 0,
        result: {
          snapshotId: created.id,
          accountId: account.id,
          superseded: state.latestExists,
          duplicate: false,
        },
        audit: {
          entityType: "account",
          entityId: account.id,
          action: "accounts.recordBalance",
          oldValue: null,
          newValue: {
            snapshotId: created.id,
            currentAmountMinor: input.currentAmountMinor,
            currencyCode: input.currencyCode,
            observedAt: input.observedAt,
            cutoffDate: input.cutoffDate,
            source: input.source,
          },
        },
        outbox: [
          {
            aggregateType: "account",
            aggregateId: account.id,
            eventType: "account.balanceRecorded",
            payload: { snapshotId: created.id, accountId: account.id },
          },
        ],
      };
    },
  };
}

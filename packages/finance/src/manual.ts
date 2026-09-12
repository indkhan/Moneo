import { isKnownCurrency } from "@moneo/shared/currencies";
import { assertSafeInteger } from "@moneo/shared/money";
import { DomainError } from "@moneo/shared/problem";
import { CommandError, type CommandDefinition, type CommandMutation } from "./commands.js";

/**
 * Issue 4.12 — manual accounts and cash transactions (pure domain).
 *
 * Two insert-only commands with the standard lifecycle (idempotency,
 * audit, outbox; versions arrive with Issue 5.2):
 *
 * - `accounts.createManual`: a user-declared account (cash wallet and
 *   friends). Same names may coexist — retry safety comes from the
 *   idempotency key, never from a name unique constraint.
 * - `transactions.createManual`: a cash transaction against an owned
 *   account. Provenance is the audit row, never a fabricated bank
 *   observation (no source rows are written anywhere in this module).
 *
 * Balance-effect contract: a transaction on/after the account's latest
 * snapshot cutoff moves the projection (`affectsProjection: true`); an
 * older one changes history only and is never applied twice — the
 * Issue 4.10 roll-forward already excludes it. Cross-currency manual rows
 * are rejected like cross-currency snapshots: without a valuation they
 * cannot roll forward honestly.
 */

const ACCOUNT_TYPES = ["CHECKING", "SAVINGS", "CASH", "CREDIT", "INVESTMENT", "WALLET", "OTHER"];

function invalid(message: string): DomainError {
  return new DomainError("VALIDATION_FAILED", {
    detail: message,
    errors: [{ field: "manual", message }],
  });
}

function checkMinor(value: string, field: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw invalid(`Invalid ${field} (expected non-negative integer string): ${value}.`);
  }
  const amount = BigInt(value);
  assertSafeInteger(amount, field);
  if (amount <= 0n) {
    throw invalid(`Invalid ${field} (must be > 0): ${value}.`);
  }
  return amount;
}

function checkIsoDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw invalid(`Invalid ${field} (expected YYYY-MM-DD): ${value}.`);
  }
  return value;
}

export interface CreateManualAccountInput {
  name: string;
  currencyCode: string;
  accountType?: string;
  institutionName?: string | null;
  isSpendable?: boolean;
  includeInNetWorth?: boolean;
}

export interface CreateManualAccountResult {
  accountId: string;
}

export interface ManualAccountData {
  insertAccount(
    workspaceId: string,
    input: Required<Pick<CreateManualAccountInput, "name" | "currencyCode">> &
      Pick<
        CreateManualAccountInput,
        "accountType" | "institutionName" | "isSpendable" | "includeInNetWorth"
      >,
  ): Promise<{ id: string }>;
}

/** `accounts.createManual`: user-declared account, no source rows. */
export function createManualAccountCommand(
  data: ManualAccountData,
): CommandDefinition<{ workspaceId: string }, CreateManualAccountInput, CreateManualAccountResult> {
  return {
    name: "accounts.createManual",
    authorize: () => {},
    loadState: (ctx) => Promise.resolve({ workspaceId: ctx.workspaceId }),
    currentVersionOf: () => null,
    checkInvariant(_state, input) {
      if (typeof input.name !== "string" || input.name.trim() === "") {
        throw new CommandError("INVARIANT_VIOLATION", "Account name is required.");
      }
      if (input.name.trim().length > 120) {
        throw new CommandError("INVARIANT_VIOLATION", "Account name is too long (max 120).");
      }
      // Runtime validation over unknown: untrusted callers can omit anything.
      const rawCurrency: unknown = (input as { currencyCode?: unknown }).currencyCode;
      const currency = typeof rawCurrency === "string" ? rawCurrency.toUpperCase() : "";
      if (!isKnownCurrency(currency)) {
        throw new CommandError("INVARIANT_VIOLATION", `Unknown currency: ${input.currencyCode}.`);
      }
      if (input.accountType !== undefined && !ACCOUNT_TYPES.includes(input.accountType)) {
        throw new CommandError(
          "INVARIANT_VIOLATION",
          `Unknown account type: ${input.accountType}.`,
        );
      }
    },
    async mutate(state, input) {
      const created = await data.insertAccount(state.workspaceId, {
        name: input.name.trim(),
        currencyCode: input.currencyCode.toUpperCase(),
        ...(input.accountType !== undefined ? { accountType: input.accountType } : {}),
        ...(input.institutionName !== undefined ? { institutionName: input.institutionName } : {}),
        ...(input.isSpendable !== undefined ? { isSpendable: input.isSpendable } : {}),
        ...(input.includeInNetWorth !== undefined
          ? { includeInNetWorth: input.includeInNetWorth }
          : {}),
      });
      const mutation: CommandMutation<CreateManualAccountResult> = {
        resultingVersion: 0,
        result: { accountId: created.id },
        audit: {
          entityType: "account",
          entityId: created.id,
          action: "accounts.createManual",
          oldValue: null,
          newValue: { name: input.name.trim(), currencyCode: input.currencyCode.toUpperCase() },
        },
        outbox: [
          {
            aggregateType: "account",
            aggregateId: created.id,
            eventType: "account.created",
            payload: { accountId: created.id },
          },
        ],
      };
      return mutation;
    },
  };
}

export interface CreateManualTransactionInput {
  accountId: string;
  effectiveDate: string;
  description: string;
  amountMinor: string;
  currencyCode: string;
  direction: "credit" | "debit";
  note?: string | null;
}

export interface CreateManualTransactionResult {
  transactionId: string;
  accountId: string;
  /** False when the row predates the balance cutoff (history only). */
  affectsProjection: boolean;
}

export interface ManualTransactionData {
  findAccount(
    workspaceId: string,
    accountId: string,
  ): Promise<{ id: string; currencyCode: string } | null>;
  latestCutoff(
    workspaceId: string,
    accountId: string,
  ): Promise<{ cutoffDate: string | null; currencyCode: string } | null>;
  insertTransaction(
    workspaceId: string,
    input: {
      accountId: string;
      effectiveDate: string;
      description: string;
      amountMinor: string;
      currencyCode: string;
      direction: "credit" | "debit";
      note: string | null;
    },
  ): Promise<{ id: string }>;
}

/** `transactions.createManual`: cash transaction with a projection contract. */
export function createManualTransactionCommand(data: ManualTransactionData): CommandDefinition<
  {
    workspaceId: string;
    account: { id: string; currencyCode: string } | null;
    cutoff: { cutoffDate: string | null; currencyCode: string } | null;
  },
  CreateManualTransactionInput,
  CreateManualTransactionResult
> {
  return {
    name: "transactions.createManual",
    authorize: () => {},
    async loadState(ctx, input) {
      const account = await data.findAccount(ctx.workspaceId, input.accountId);
      return {
        workspaceId: ctx.workspaceId,
        account,
        cutoff: account ? await data.latestCutoff(ctx.workspaceId, account.id) : null,
      };
    },
    currentVersionOf: () => null,
    checkInvariant(state, input) {
      if (!state.account) {
        throw new CommandError("FORBIDDEN", "Account not found in this workspace.");
      }
      checkIsoDate(input.effectiveDate, "effectiveDate");
      if (typeof input.description !== "string" || input.description.trim() === "") {
        throw new CommandError("INVARIANT_VIOLATION", "Description is required.");
      }
      if (input.description.trim().length > 500) {
        throw new CommandError("INVARIANT_VIOLATION", "Description is too long (max 500).");
      }
      checkMinor(input.amountMinor, "amountMinor");
      const direction: string = input.direction;
      if (direction !== "credit" && direction !== "debit") {
        throw new CommandError("INVARIANT_VIOLATION", `Unknown direction: ${input.direction}.`);
      }
      // Runtime validation over unknown: untrusted callers can omit anything.
      const rawCurrency: unknown = (input as { currencyCode?: unknown }).currencyCode;
      const currency = typeof rawCurrency === "string" ? rawCurrency.toUpperCase() : "";
      if (!isKnownCurrency(currency)) {
        throw new CommandError("INVARIANT_VIOLATION", `Unknown currency: ${input.currencyCode}.`);
      }
      if (currency !== state.account.currencyCode.toUpperCase()) {
        throw new CommandError(
          "INVARIANT_VIOLATION",
          `Transaction currency ${currency} must match account currency ${state.account.currencyCode}.`,
        );
      }
      if (input.note !== undefined && input.note !== null && input.note.length > 2000) {
        throw new CommandError("INVARIANT_VIOLATION", "Note is too long (max 2000).");
      }
    },
    async mutate(state, input) {
      const account = state.account;
      if (!account) {
        throw new CommandError("FORBIDDEN", "Account not found in this workspace.");
      }
      const created = await data.insertTransaction(state.workspaceId, {
        accountId: account.id,
        effectiveDate: input.effectiveDate,
        description: input.description.trim(),
        amountMinor: input.amountMinor,
        currencyCode: input.currencyCode.toUpperCase(),
        direction: input.direction,
        note: input.note ?? null,
      });
      const cutoff = state.cutoff?.cutoffDate ?? null;
      const affectsProjection = cutoff !== null && input.effectiveDate >= cutoff;
      const mutation: CommandMutation<CreateManualTransactionResult> = {
        resultingVersion: 0,
        result: { transactionId: created.id, accountId: account.id, affectsProjection },
        audit: {
          entityType: "transaction",
          entityId: created.id,
          action: "transactions.createManual",
          oldValue: null,
          newValue: {
            accountId: account.id,
            effectiveDate: input.effectiveDate,
            amountMinor: input.amountMinor,
            affectsProjection,
          },
        },
        outbox: [
          {
            aggregateType: "transaction",
            aggregateId: created.id,
            eventType: "transaction.created",
            payload: { transactionId: created.id, accountId: account.id },
          },
        ],
      };
      return mutation;
    },
  };
}

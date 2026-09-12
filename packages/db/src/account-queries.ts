import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import type { Db } from "./client.js";
import { accountBalanceSnapshots, accounts, type Account } from "./schema.js";
import type * as schema from "./schema.js";

/**
 * Issue 4.5 — canonical account query services.
 *
 * Read-only by design: the Money screens (Issue 4.7) and the deterministic
 * finance tools (Epoch 6) share these exact functions, so UI/API/AI can
 * never diverge on what an account or balance means. Runs inside
 * `withWorkspaceTransaction` at the call site; every predicate repeats
 * `workspaceId`, so a caller bug fails closed under RLS even before it
 * returns a wrong row.
 *
 * Balance semantics preview Issue 4.10: the newest snapshot by
 * (`observed_at` DESC, `id` DESC) wins — `id` is UUIDv7 (time-ordered), the
 * tiebreak that keeps same-millisecond inserts deterministic on every
 * backend. No snapshot means UNKNOWN, surfaced as `null` — never zero.
 */

export type AccountQueryDb = Db | PgliteDatabase<typeof schema> | NodePgDatabase<typeof schema>;

export interface BalanceView {
  accountId: string;
  /** Decimal-string minor units, or null when no snapshot exists (unknown). */
  currentAmountMinor: string | null;
  availableAmountMinor: string | null;
  currencyCode: string;
  observedAt: Date;
  source: string;
}

/** Workspace accounts in stable creation order; archived hidden by default. */
export async function listAccounts(
  db: AccountQueryDb,
  workspaceId: string,
  options: { includeArchived?: boolean } = {},
): Promise<Account[]> {
  const filters = [eq(accounts.workspaceId, workspaceId)];
  if (!options.includeArchived) {
    filters.push(isNull(accounts.archivedAt));
  }
  return db
    .select()
    .from(accounts)
    .where(and(...filters))
    .orderBy(asc(accounts.createdAt), asc(accounts.id));
}

export async function getAccount(
  db: AccountQueryDb,
  workspaceId: string,
  accountId: string,
): Promise<Account | null> {
  const rows = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.id, accountId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Newest snapshot per requested account. Accounts without a snapshot are
 * ABSENT from the map — the caller renders unknown, never zero. (Issue 4.10
 * adds the reconciliation preview and coverage flags on top of this.)
 */
export async function getAccountBalances(
  db: AccountQueryDb,
  workspaceId: string,
  accountIds: readonly string[],
): Promise<Map<string, BalanceView>> {
  const result = new Map<string, BalanceView>();
  const unique = [...new Set(accountIds)];
  if (unique.length === 0) {
    return result;
  }
  const rows = await db
    .select()
    .from(accountBalanceSnapshots)
    .where(
      and(
        eq(accountBalanceSnapshots.workspaceId, workspaceId),
        inArray(accountBalanceSnapshots.accountId, unique),
      ),
    )
    // Newest first per account; the id tiebreak keeps same-millisecond
    // supersedes deterministic (UUIDv7 is time-ordered).
    .orderBy(
      asc(accountBalanceSnapshots.accountId),
      desc(accountBalanceSnapshots.observedAt),
      desc(accountBalanceSnapshots.id),
    );
  for (const row of rows) {
    if (!result.has(row.accountId)) {
      result.set(row.accountId, {
        accountId: row.accountId,
        currentAmountMinor:
          row.currentAmountMinor === null ? null : String(row.currentAmountMinor),
        availableAmountMinor:
          row.availableAmountMinor === null ? null : String(row.availableAmountMinor),
        currencyCode: row.currencyCode,
        observedAt: row.observedAt,
        source: row.source,
      });
    }
  }
  return result;
}

import {
  getAccount,
  getAccountBalances,
  listAccounts,
  type BalanceView,
} from "@moneo/db/account-queries";
import type { Account as DbAccount } from "@moneo/db/schema";
import { withWorkspaceTransaction } from "@moneo/db/tenancy";
import { DomainError, problemResponse } from "@moneo/shared/problem";
import { NextResponse } from "next/server";
import type { Account as AccountDto } from "../generated/client";
import { accountIdSchema, accountListQuerySchema, parseOrProblem } from "./contract";

/**
 * Issue 4.7 — canonical account HTTP surface.
 *
 * Thin adapters over the shared query services (Issue 4.5): the ONLY SQL
 * runs inside `withWorkspaceTransaction`, DTOs serialize money as decimal
 * strings, and a missing balance stays `null` (unknown, never zero) from
 * the query layer to the wire. Storage is injected so handlers unit-test
 * without Postgres; the route default is the Drizzle implementation below.
 */

export interface MoneyAccountStore {
  list(workspaceId: string, options: { includeArchived?: boolean }): Promise<DbAccount[]>;
  get(workspaceId: string, accountId: string): Promise<DbAccount | null>;
  balances(workspaceId: string, accountIds: string[]): Promise<Map<string, BalanceView>>;
}

export function createDrizzleMoneyAccountStore(): MoneyAccountStore {
  return {
    list: (workspaceId, options) =>
      withWorkspaceTransaction(workspaceId, (tx) => listAccounts(tx, workspaceId, options)),
    get: (workspaceId, accountId) =>
      withWorkspaceTransaction(workspaceId, (tx) => getAccount(tx, workspaceId, accountId)),
    balances: (workspaceId, accountIds) =>
      withWorkspaceTransaction(workspaceId, (tx) =>
        getAccountBalances(tx, workspaceId, accountIds),
      ),
  };
}

export function toAccountDto(account: DbAccount, balance: BalanceView | null): AccountDto {
  return {
    id: account.id,
    name: account.name,
    institutionName: account.institutionName,
    accountType: account.accountType as AccountDto["accountType"],
    currencyCode: account.currencyCode,
    isSpendable: account.isSpendable,
    includeInNetWorth: account.includeInNetWorth,
    archivedAt: account.archivedAt?.toISOString() ?? null,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
    balance: balance
      ? {
          currentAmountMinor: balance.currentAmountMinor,
          availableAmountMinor: balance.availableAmountMinor,
          currencyCode: balance.currencyCode,
          observedAt: balance.observedAt.toISOString(),
          source: balance.source,
        }
      : null,
  };
}

function unauthorized(): Response {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

function splitQuery(value: string | null): Record<string, string> {
  const params = new URLSearchParams(value ?? "");
  return Object.fromEntries(params.entries());
}

/** GET /api/v1/accounts — workspace accounts with latest known balances. */
export async function handleListAccounts(
  query: string | null,
  ctx: { workspaceId: string | undefined; accounts: MoneyAccountStore },
): Promise<Response> {
  if (!ctx.workspaceId) {
    return unauthorized();
  }
  const parsed = parseOrProblem(accountListQuerySchema, splitQuery(query), "/accounts");
  if (!parsed.ok) {
    return problemResponse(parsed.error);
  }
  const rows = await ctx.accounts.list(ctx.workspaceId, {
    ...(parsed.data.includeArchived !== undefined
      ? { includeArchived: parsed.data.includeArchived }
      : {}),
  });
  const balances = await ctx.accounts.balances(
    ctx.workspaceId,
    rows.map((a) => a.id),
  );
  return NextResponse.json({ items: rows.map((a) => toAccountDto(a, balances.get(a.id) ?? null)) });
}

/** GET /api/v1/accounts/{id} — one account; foreign ids answer 404. */
export async function handleGetAccount(
  id: unknown,
  ctx: { workspaceId: string | undefined; accounts: MoneyAccountStore },
): Promise<Response> {
  if (!ctx.workspaceId) {
    return unauthorized();
  }
  const parsed = parseOrProblem(accountIdSchema, id, "/accounts/{id}");
  if (!parsed.ok) {
    return problemResponse(parsed.error);
  }
  const account = await ctx.accounts.get(ctx.workspaceId, parsed.data);
  if (!account) {
    return problemResponse(new DomainError("NOT_FOUND", { detail: "Account not found." }));
  }
  const balances = await ctx.accounts.balances(ctx.workspaceId, [account.id]);
  return NextResponse.json(toAccountDto(account, balances.get(account.id) ?? null));
}

import type { Transaction } from "@moneo/db/schema";
import { DomainError } from "@moneo/shared/problem";
import { describe, expect, it } from "vitest";
import {
  handleSearchTransactions,
  searchCursorSecret,
  toTransactionDto,
  type MoneyTransactionStore,
} from "./money-transactions";

/**
 * Issue 4.7 — transaction search handler unit-tests without Postgres.
 *
 * Proves the HTTP boundary: 401 without a workspace, contract validation
 * before any store call, filter forwarding, exact decimal-string money on
 * the wire, opaque cursor passthrough, and domain errors mapped onto the
 * documented problem shape.
 */

const WID = "11111111-1111-7111-8111-111111111111";

function row(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "22222222-2222-7222-8222-222222222222",
    workspaceId: WID,
    accountId: "33333333-3333-7333-8333-333333333333",
    status: "POSTED",
    direction: "debit",
    amountMinor: 1550,
    currencyCode: "EUR",
    effectiveDate: "2026-08-15",
    authorizedAt: null,
    postedAt: null,
    counterpartyId: null,
    categoryId: null,
    description: "COFFEE BAR",
    note: null,
    excludedFromAnalytics: false,
    version: 1,
    createdAt: new Date("2026-08-15T10:00:00Z"),
    updatedAt: new Date("2026-08-15T10:00:00Z"),
    archivedAt: null,
    ...overrides,
  };
}

describe("handleSearchTransactions", () => {
  it("answers 401 without a workspace and never touches the store", async () => {
    let calls = 0;
    const res = await handleSearchTransactions("", {
      workspaceId: undefined,
      transactions: {
        search: () => ((calls += 1), Promise.resolve({ items: [], nextCursor: null })),
      },
    });
    expect(res.status).toBe(401);
    expect(calls).toBe(0);
  });

  it("forwards filters and serializes the page exactly", async () => {
    const seen: unknown[] = [];
    const res = await handleSearchTransactions(
      "?accountIds=33333333-3333-7333-8333-333333333333&directions=debit&q=coffee&sort=oldest&limit=10",
      {
        workspaceId: WID,
        transactions: {
          search: (_wid, input) => {
            seen.push(input);
            return Promise.resolve({ items: [row()], nextCursor: "cursor-2" });
          },
        } satisfies MoneyTransactionStore,
      },
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual([
      {
        accountIds: "33333333-3333-7333-8333-333333333333",
        directions: "debit",
        text: "coffee",
        sort: "oldest",
        limit: 10,
      },
    ]);
    const body = (await res.json()) as {
      items: { amountMinor: string; effectiveDate: string }[];
      nextCursor: string | null;
    };
    expect(body.items[0]?.amountMinor).toBe("1550");
    expect(body.items[0]?.effectiveDate).toBe("2026-08-15");
    expect(body.nextCursor).toBe("cursor-2");
  });

  it("rejects malformed queries before any store call", async () => {
    let calls = 0;
    const ctx = {
      workspaceId: WID,
      transactions: {
        search: () => ((calls += 1), Promise.resolve({ items: [], nextCursor: null })),
      } satisfies MoneyTransactionStore,
    };
    for (const query of [
      "?limit=1000",
      "?sort=amount",
      "?amountMin=12.50",
      "?dateFrom=15.08.2026",
    ]) {
      const res = await handleSearchTransactions(query, ctx);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("VALIDATION_FAILED");
    }
    expect(calls).toBe(0);
  });

  it("maps domain errors (bad cursor) onto the problem shape", async () => {
    const res = await handleSearchTransactions("?cursor=forged", {
      workspaceId: WID,
      transactions: {
        search: () => {
          throw new DomainError("VALIDATION_FAILED", { detail: "Invalid cursor (bad signature)." });
        },
      },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("VALIDATION_FAILED");
  });
});

describe("searchCursorSecret", () => {
  it("prefers the dedicated secret, falls back to the session secret, else fails", () => {
    expect(
      searchCursorSecret({
        SEARCH_CURSOR_SECRET: "cursor-secret",
        SESSION_SECRET: "session-secret",
      } as never),
    ).toBe("cursor-secret");
    expect(searchCursorSecret({ SESSION_SECRET: "session-secret" } as never)).toBe(
      "session-secret",
    );
    expect(() => searchCursorSecret({} as never)).toThrow(DomainError);
  });
});

describe("toTransactionDto", () => {
  it("keeps minor units as decimal strings and dates stable", () => {
    const dto = toTransactionDto(row({ amountMinor: 9007199254740991 }));
    expect(dto.amountMinor).toBe("9007199254740991");
    expect(dto.createdAt).toBe("2026-08-15T10:00:00.000Z");
    expect(dto.note).toBeNull();
  });
});

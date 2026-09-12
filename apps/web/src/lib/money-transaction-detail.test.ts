import type { Transaction } from "@moneo/db/schema";
import type { TransactionDetail as DbTransactionDetail } from "@moneo/db/transaction-detail";
import { describe, expect, it } from "vitest";
import {
  handleGetTransaction,
  toTransactionDetailDto,
  type TransactionDetailStore,
} from "./money-transaction-detail";

/**
 * Issue 4.8 — transaction detail handler unit-tests without Postgres.
 *
 * Proves the HTTP boundary: 401 without a workspace, 404 for unknown and
 * foreign ids, 400 for malformed ids, and DTO provenance with verbatim raw
 * payloads for "View original".
 */

const WID = "11111111-1111-7111-8111-111111111111";
const TID = "22222222-2222-7222-8222-222222222222";

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: TID,
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

function detail(overrides: Partial<DbTransactionDetail> = {}): DbTransactionDetail {
  return {
    transaction: transaction(),
    accountName: "Everyday checking",
    sources: [
      {
        sourceTransactionId: "55555555-5555-7555-8555-555555555555",
        relationship: "PRIMARY",
        dataSourceId: "66666666-6666-7666-8666-666666666666",
        dataSourceName: "Revolut CSV",
        importId: "77777777-7777-7777-8777-777777777777",
        fileName: "august.csv",
        observedAt: new Date("2026-08-15T10:00:00Z"),
        rawPayload: { date: "15.08.2026", amount: "15,50" },
      },
    ],
    ...overrides,
  };
}

function store(found: DbTransactionDetail | null): TransactionDetailStore {
  return { find: () => Promise.resolve(found) };
}

describe("handleGetTransaction", () => {
  it("answers 401 without a workspace and never touches the store", async () => {
    let calls = 0;
    const res = await handleGetTransaction(TID, {
      workspaceId: undefined,
      detail: { find: () => ((calls += 1), Promise.resolve(detail())) },
    });
    expect(res.status).toBe(401);
    expect(calls).toBe(0);
  });

  it("returns canonical fields with verbatim provenance", async () => {
    const res = await handleGetTransaction(TID, { workspaceId: WID, detail: store(detail()) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      description: string;
      amountMinor: string;
      accountName: string;
      sources: { fileName: string; rawPayload: Record<string, unknown> }[];
    };
    expect(body.description).toBe("COFFEE BAR");
    expect(body.amountMinor).toBe("1550");
    expect(body.accountName).toBe("Everyday checking");
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0]?.fileName).toBe("august.csv");
    expect(body.sources[0]?.rawPayload).toEqual({ date: "15.08.2026", amount: "15,50" });
  });

  it("answers 404 for unknown ids and 400 for malformed ids", async () => {
    const missing = await handleGetTransaction(TID, { workspaceId: WID, detail: store(null) });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code: string }).code).toBe("NOT_FOUND");

    const malformed = await handleGetTransaction("nope", {
      workspaceId: WID,
      detail: store(detail()),
    });
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as { code: string }).code).toBe("VALIDATION_FAILED");
  });
});

describe("toTransactionDetailDto", () => {
  it("keeps manual rows sourceless and dates stable", () => {
    const dto = toTransactionDetailDto(detail({ sources: [] }));
    expect(dto.sources).toEqual([]);
    expect(dto.accountName).toBe("Everyday checking");
    expect(dto.sources).toHaveLength(0);
  });
});

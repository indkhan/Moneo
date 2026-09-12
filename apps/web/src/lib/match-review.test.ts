import { describe, expect, it } from "vitest";
import { handleListPendingMatches } from "./match-review";

/**
 * Issue 4.11 — pending-match handler unit-tests without Postgres.
 *
 * Proves the read-only boundary: 401 without a workspace, 400 for missing
 * or malformed import ids, and verbatim passthrough of staged rows.
 */

const WID = "11111111-1111-7111-8111-111111111111";
const IID = "22222222-2222-7222-8222-222222222222";

describe("handleListPendingMatches", () => {
  it("answers 401 without a workspace and never touches the store", async () => {
    let calls = 0;
    const res = await handleListPendingMatches(`?importId=${IID}`, {
      workspaceId: undefined,
      review: { list: () => ((calls += 1), Promise.resolve([])) },
    });
    expect(res.status).toBe(401);
    expect(calls).toBe(0);
  });

  it("lists staged rows for one import", async () => {
    const seen: unknown[] = [];
    const res = await handleListPendingMatches(`?importId=${IID}`, {
      workspaceId: WID,
      review: {
        list: (workspaceId, importId) => {
          seen.push({ workspaceId, importId });
          return Promise.resolve([
            {
              id: "33333333-3333-7333-8333-333333333333",
              importId,
              sourceTransactionId: "44444444-4444-7444-8444-444444444444",
              candidateTransactionId: "55555555-5555-7555-8555-555555555555",
              matchRule: "fuzzy-date-amount-description",
              candidateDate: "2026-08-12",
              candidateDescription: "BOOKSTORE",
              candidateAmountMinor: "2499",
              candidateCurrency: "EUR",
              stagedDescription: "Bookstore",
              stagedDate: "2026-08-12",
              stagedAmountMinor: "2499",
              stagedCurrency: "EUR",
              stagedDirection: "debit" as const,
              createdAt: "2026-09-01T00:00:00.000Z",
            },
          ]);
        },
      },
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ workspaceId: WID, importId: IID }]);
    const body = (await res.json()) as { items: { stagedDescription: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.stagedDescription).toBe("Bookstore");
  });

  it("rejects missing and malformed import ids before any store call", async () => {
    let calls = 0;
    const ctx = {
      workspaceId: WID,
      review: { list: () => ((calls += 1), Promise.resolve([])) },
    };
    for (const query of ["", "?importId=not-a-uuid"]) {
      const res = await handleListPendingMatches(query, ctx);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("VALIDATION_FAILED");
    }
    expect(calls).toBe(0);
  });
});

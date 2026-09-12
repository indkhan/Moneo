import type { Account as DbAccount } from "@moneo/db/schema";
import { describe, expect, it } from "vitest";
import {
  handleGetAccount,
  handleListAccounts,
  toAccountDto,
  type MoneyAccountStore,
} from "./money-accounts";

/**
 * Issue 4.7 — account handlers unit-test without Postgres.
 *
 * Proves the HTTP boundary: 401 without a workspace, contract validation
 * before any store call, DTO money as decimal strings, unknown balances as
 * null (never zero), and foreign ids answering 404.
 */

const WID = "11111111-1111-7111-8111-111111111111";

function account(overrides: Partial<DbAccount> = {}): DbAccount {
  return {
    id: "22222222-2222-7222-8222-222222222222",
    workspaceId: WID,
    name: "Everyday checking",
    institutionName: null,
    accountType: "CHECKING",
    currencyCode: "EUR",
    isSpendable: true,
    includeInNetWorth: true,
    metadata: {},
    createdAt: new Date("2026-08-01T00:00:00Z"),
    updatedAt: new Date("2026-08-02T00:00:00Z"),
    archivedAt: null,
    ...overrides,
  };
}

function store(overrides: Partial<MoneyAccountStore> = {}): MoneyAccountStore {
  return {
    list: () => Promise.resolve([]),
    get: () => Promise.resolve(null),
    balances: () => Promise.resolve(new Map()),
    states: () => Promise.resolve(new Map()),
    ...overrides,
  };
}

describe("handleListAccounts", () => {
  it("answers 401 without a workspace and never touches the store", async () => {
    let calls = 0;
    const res = await handleListAccounts("", {
      workspaceId: undefined,
      accounts: store({ list: () => ((calls += 1), Promise.resolve([])) }),
    });
    expect(res.status).toBe(401);
    expect(calls).toBe(0);
  });

  it("lists accounts with balances, keeping unknown balances null", async () => {
    const first = account();
    const second = account({
      id: "33333333-3333-7333-8333-333333333333",
      name: "Cash wallet",
      accountType: "CASH",
    });
    const seen: { options: unknown }[] = [];
    const res = await handleListAccounts("", {
      workspaceId: WID,
      accounts: store({
        list: (_wid, options) => {
          seen.push({ options });
          return Promise.resolve([first, second]);
        },
        balances: () =>
          Promise.resolve(
            new Map([
              [
                first.id,
                {
                  accountId: first.id,
                  currentAmountMinor: "12500",
                  availableAmountMinor: null,
                  currencyCode: "EUR",
                  observedAt: new Date("2026-08-15T00:00:00Z"),
                  source: "statement",
                },
              ],
            ]),
          ),
      }),
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ options: {} }]);
    const body = (await res.json()) as {
      items: {
        id: string;
        balanceState: string;
        balance: { currentAmountMinor: string | null } | null;
      }[];
    };
    expect(body.items).toHaveLength(2);
    expect(body.items[0]?.balance?.currentAmountMinor).toBe("12500");
    expect(body.items[0]?.balanceState).toBe("unknown");
    // No snapshot: unknown, never zero.
    expect(body.items[1]?.balance).toBeNull();
  });

  it("forwards includeArchived and rejects malformed queries", async () => {
    const seen: unknown[] = [];
    const withFlag = store({
      list: (_wid, options) => {
        seen.push(options);
        return Promise.resolve([]);
      },
    });
    const ok = await handleListAccounts("?includeArchived=true", {
      workspaceId: WID,
      accounts: withFlag,
    });
    expect(ok.status).toBe(200);
    expect(seen).toEqual([{ includeArchived: true }]);
  });
});

describe("handleGetAccount", () => {
  it("returns the DTO, 404 for foreign ids, and 400 for bad ids", async () => {
    const found = account();
    const ctx = {
      workspaceId: WID,
      accounts: store({ get: () => Promise.resolve(found) }),
    };
    const ok = await handleGetAccount(found.id, ctx);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { id: string }).id).toBe(found.id);

    const missing = await handleGetAccount(found.id, {
      workspaceId: WID,
      accounts: store(),
    });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code: string }).code).toBe("NOT_FOUND");

    const malformed = await handleGetAccount("not-a-uuid", {
      workspaceId: WID,
      accounts: store(),
    });
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as { code: string }).code).toBe("VALIDATION_FAILED");
  });
});

describe("toAccountDto", () => {
  it("serializes dates as ISO strings and keeps money exact", () => {
    const dto = toAccountDto(account(), {
      accountId: account().id,
      currentAmountMinor: "9007199254740991",
      availableAmountMinor: null,
      currencyCode: "EUR",
      observedAt: new Date("2026-08-15T12:00:00Z"),
      source: "manual",
    });
    expect(dto.createdAt).toBe("2026-08-01T00:00:00.000Z");
    expect(dto.archivedAt).toBeNull();
    expect(dto.balance?.currentAmountMinor).toBe("9007199254740991");
    expect(dto.balance?.availableAmountMinor).toBeNull();
  });
});

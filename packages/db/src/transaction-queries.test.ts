import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { DomainError } from "@moneo/shared/problem";
import * as schema from "./schema.js";
import { accounts, transactions, workspaces } from "./schema.js";
import {
  createSearchCursorCodec,
  searchTransactions,
  type TransactionSearchInput,
} from "./transaction-queries.js";
import { createMigratedDb, one } from "./pglite-test-db.js";
import { TENANT_SETTING } from "./tenancy.js";
import { uuidv7 } from "./uuid.js";

/**
 * Issue 4.6 — cursor-based transaction search.
 *
 * Proves against the REAL migrated schema: full pagination over a
 * same-date-heavy dataset is complete, ordered, and duplicate-free; every
 * filter (account, date range, direction, amount range, text) narrows
 * correctly; tampered and cross-workspace cursors are rejected; malformed
 * input fails as VALIDATION_FAILED; and the app role stays tenant-safe.
 */
describe("cursor-based transaction search (issue 4.6)", () => {
  let pg!: PGlite;
  let wsA!: string;
  let wsB!: string;
  let acctA1!: string;
  let acctA2!: string;

  const codec = createSearchCursorCodec("test-secret-for-issue-4-6");

  async function asApp<T>(workspaceId: string | null, fn: () => Promise<T>): Promise<T> {
    await pg.exec("SET ROLE moneo_app");
    try {
      if (workspaceId === null) {
        await pg.exec(`RESET ${TENANT_SETTING}`);
      } else {
        await pg.exec(`SET ${TENANT_SETTING} = '${workspaceId}'`);
      }
      return await fn();
    } finally {
      await pg.exec(`RESET ${TENANT_SETTING}`);
      await pg.exec("RESET ROLE");
    }
  }

  async function search(input: TransactionSearchInput) {
    const db = drizzlePglite(pg, { schema });
    return searchTransactions(db, wsA, input, codec);
  }

  beforeAll(async () => {
    pg = await createMigratedDb("0009_canonical_transactions");
    const db = drizzlePglite(pg, { schema });
    wsA = one(await db.insert(workspaces).values({ name: "Search A" }).returning()).id;
    wsB = one(await db.insert(workspaces).values({ name: "Search B" }).returning()).id;
    acctA1 = one(
      await db
        .insert(accounts)
        .values({ workspaceId: wsA, name: "Everyday", currencyCode: "EUR" })
        .returning(),
    ).id;
    acctA2 = one(
      await db
        .insert(accounts)
        .values({ workspaceId: wsA, name: "Savings", currencyCode: "EUR" })
        .returning(),
    ).id;

    // 30 rows sharing ONE date (cursor-stability stress) + spread rows for
    // filters + one foreign-workspace row that must never appear.
    const rows: (typeof transactions.$inferInsert)[] = [];
    for (let i = 0; i < 30; i += 1) {
      rows.push({
        workspaceId: wsA,
        accountId: i % 2 === 0 ? acctA1 : acctA2,
        direction: i % 3 === 0 ? "credit" : "debit",
        amountMinor: 100 + i,
        currencyCode: "EUR",
        effectiveDate: "2026-08-15",
        description: `SHARED DATE PURCHASE ${i}`,
      });
    }
    rows.push(
      {
        workspaceId: wsA,
        accountId: acctA1,
        direction: "credit",
        amountMinor: 200000,
        currencyCode: "EUR",
        effectiveDate: "2026-08-01",
        description: "SALARY AUGUST",
      },
      {
        workspaceId: wsA,
        accountId: acctA2,
        direction: "debit",
        amountMinor: 99900,
        currencyCode: "EUR",
        effectiveDate: "2026-09-02",
        description: "RENT SEPTEMBER",
      },
      {
        workspaceId: wsA,
        accountId: acctA1,
        direction: "debit",
        amountMinor: 350,
        currencyCode: "EUR",
        effectiveDate: "2026-07-10",
        description: "Coffee Bar downtown",
      },
    );
    for (const row of rows) {
      await db.insert(transactions).values(row);
    }
    const acctB = one(
      await db
        .insert(accounts)
        .values({ workspaceId: wsB, name: "Foreign", currencyCode: "EUR" })
        .returning(),
    );
    await db.insert(transactions).values({
      workspaceId: wsB,
      accountId: acctB.id,
      direction: "debit",
      amountMinor: 1,
      currencyCode: "EUR",
      effectiveDate: "2026-08-15",
      description: "FOREIGN SECRET",
    });
  });

  afterAll(async () => {
    await pg.close();
  });

  async function collectAll(input: TransactionSearchInput): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const result = await search({ ...input, limit: 7, cursor });
      ids.push(...result.items.map((t) => t.id));
      cursor = result.nextCursor;
      if (cursor === null) {
        break;
      }
    }
    return ids;
  }

  it("paginates the whole set with no gaps, dupes, or order breaks", async () => {
    const ids = await collectAll({});
    // 33 workspace-A rows, every id exactly once.
    expect(ids).toHaveLength(33);
    expect(new Set(ids).size).toBe(33);

    const db = drizzlePglite(pg, { schema });
    const first = await searchTransactions(db, wsA, { limit: 33 }, codec);
    expect(first.items.map((t) => t.id)).toEqual(ids);
    expect(first.nextCursor).toBeNull();

    // Default keyset: effective_date DESC, id DESC.
    const items = first.items;
    for (let i = 1; i < items.length; i += 1) {
      const prev = items[i - 1] as (typeof items)[number];
      const cur = items[i] as (typeof items)[number];
      const ordered =
        prev.effectiveDate > cur.effectiveDate ||
        (prev.effectiveDate === cur.effectiveDate && prev.id > cur.id);
      expect(ordered).toBe(true);
    }
  });

  it("narrows with every supported filter", async () => {
    expect((await search({ accountIds: [acctA1], limit: 100 })).items.every((t) =>
      [acctA1].includes(t.accountId),
    )).toBe(true);
    expect((await search({ accountIds: [], limit: 100 })).items).toEqual([]);

    const august = await search({ dateFrom: "2026-08-01", dateTo: "2026-08-31", limit: 100 });
    expect(august.items).toHaveLength(31);
    expect(august.items.every((t) => t.effectiveDate >= "2026-08-01" && t.effectiveDate <= "2026-08-31")).toBe(
      true,
    );

    const credits = await search({ directions: ["credit"], limit: 100 });
    expect(credits.items.length).toBeGreaterThan(0);
    expect(credits.items.every((t) => t.direction === "credit")).toBe(true);

    const pricey = await search({ amountMin: "99900", amountMax: "200000", limit: 100 });
    expect(pricey.items.map((t) => t.description).sort()).toEqual(
      ["RENT SEPTEMBER", "SALARY AUGUST"].sort(),
    );

    const coffee = await search({ text: "coffee bar", limit: 100 });
    expect(coffee.items).toHaveLength(1);
    expect(coffee.items[0]?.description).toBe("Coffee Bar downtown");

    // LIKE wildcards in user text are literal, not patterns.
    expect((await search({ text: "%", limit: 100 })).items).toHaveLength(0);

    const oldest = await search({ sort: "oldest", limit: 100 });
    expect(oldest.items[0]?.effectiveDate).toBe("2026-07-10");
  });

  it("rejects tampered, foreign, and stale-sort cursors", async () => {
    const first = await search({ limit: 5 });
    expect(first.nextCursor).not.toBeNull();
    const cursor = first.nextCursor as string;

    // Tampered payload fails the signature.
    const [body] = cursor.split(".");
    await expect(search({ limit: 5, cursor: `${body}.deadbeef` })).rejects.toThrow(DomainError);
    await expect(search({ limit: 5, cursor: "not-a-cursor" })).rejects.toThrow(DomainError);

    // A cursor minted for B is useless in A.
    const db = drizzlePglite(pg, { schema });
    const foreign = createSearchCursorCodec("test-secret-for-issue-4-6").encode({
      w: wsB,
      s: "newest",
      d: "2026-08-15",
      i: uuidv7(),
    });
    await expect(
      searchTransactions(db, wsA, { limit: 5, cursor: foreign }, codec),
    ).rejects.toThrow(/wrong workspace/);

    // Same cursor under the other sort is rejected, never misordered.
    await expect(search({ limit: 5, cursor, sort: "oldest" })).rejects.toThrow(/sort changed/);
  });

  it("fails malformed input as VALIDATION_FAILED", async () => {
    for (const bad of [
      { dateFrom: "15.08.2026" },
      { dateTo: "2026-13-01" },
      { dateFrom: "2026-09-01", dateTo: "2026-08-01" },
      { directions: ["OUTFLOW"] },
      { amountMin: "12.50" },
      { amountMin: "-5" },
      { amountMin: "200", amountMax: "100" },
      { text: "x".repeat(201) },
      { sort: "amount" },
      { accountIds: ["not-a-uuid"] },
    ] as TransactionSearchInput[]) {
      await expect(search({ ...bad, limit: 5 })).rejects.toThrow(DomainError);
    }
  });

  it("stays tenant-safe under the app role", async () => {
    const db = drizzlePglite(pg, { schema });
    await asApp(wsA, async () => {
      const page = await searchTransactions(db, wsA, { limit: 100 }, codec);
      expect(page.items).toHaveLength(33);
      expect(page.items.some((t) => t.description === "FOREIGN SECRET")).toBe(false);
      // Forged workspace fails closed (sees nothing).
      expect((await searchTransactions(db, wsB, { limit: 100 }, codec)).items).toEqual([]);
    });
    await asApp(null, async () => {
      expect((await searchTransactions(db, wsA, { limit: 5 }, codec)).items).toEqual([]);
    });
  });
});

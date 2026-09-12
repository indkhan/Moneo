import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema.js";
import { accounts, transactions, workspaces } from "./schema.js";
import { createSearchCursorCodec, searchTransactions } from "./transaction-queries.js";
import { createMigratedDb, one } from "./pglite-test-db.js";

/**
 * Epoch 4 acceptance: import a large fixture and browse it without loading
 * the entire dataset into the browser.
 *
 * Seeds 1,500 canonical transactions sharing ONE effective date (the
 * worst case for cursor stability) and walks the whole set in pages of 50:
 * every id appears exactly once, global order never breaks
 * (effective_date DESC, id DESC), and no page ever holds more than the
 * requested limit. Deterministic ordering with shared dates is what makes
 * the Money screens safe on real imports.
 */
describe("epoch 4 acceptance — large.fixture browsing", () => {
  let pg!: PGlite;
  let ws!: string;
  let acct!: string;

  const codec = createSearchCursorCodec("epoch-4-acceptance-secret");

  beforeAll(async () => {
    pg = await createMigratedDb("0013_import_matching");
    const db = drizzlePglite(pg, { schema });
    ws = one(await db.insert(workspaces).values({ name: "Epoch 4" }).returning()).id;
    acct = one(
      await db
        .insert(accounts)
        .values({ workspaceId: ws, name: "Everyday", currencyCode: "EUR" })
        .returning(),
    ).id;
    const batch: (typeof transactions.$inferInsert)[] = [];
    for (let i = 0; i < 1500; i += 1) {
      batch.push({
        workspaceId: ws,
        accountId: acct,
        direction: i % 2 === 0 ? "debit" : "credit",
        amountMinor: 100 + (i % 999),
        currencyCode: "EUR",
        effectiveDate: "2026-08-15",
        description: `FIXTURE ROW ${i}`,
      });
      if (batch.length >= 250) {
        for (const row of batch.splice(0)) {
          await db.insert(transactions).values(row);
        }
      }
    }
  }, 120_000);

  afterAll(async () => {
    await pg.close();
  });

  it("walks 1,500 same-date rows in bounded, stable, duplicate-free pages", async () => {
    const db = drizzlePglite(pg, { schema });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (let page = 0; page < 40; page += 1) {
      const result = await searchTransactions(db, ws, { limit: 50, cursor }, codec);
      expect(result.items.length).toBeLessThanOrEqual(50);
      seen.push(...result.items.map((t) => `${t.effectiveDate}|${t.id}`));
      pages += 1;
      cursor = result.nextCursor;
      if (cursor === null) {
        break;
      }
    }
    expect(pages).toBe(30);
    expect(seen).toHaveLength(1500);
    expect(new Set(seen).size).toBe(1500);
    const sorted = [...seen].sort().reverse();
    expect(seen).toEqual(sorted);
  }, 120_000);
});

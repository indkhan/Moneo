import { eq } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { DomainError } from "@moneo/shared/problem";
import * as schema from "./schema.js";
import { accounts, transactionValuations, transactions, workspaces } from "./schema.js";
import {
  getBaseCurrency,
  lookupRate,
  rebuildValuations,
  setBaseCurrency,
  upsertManualRate,
} from "./fx-valuations.js";
import { createMigratedDb, expectDbError, one, tableNames } from "./pglite-test-db.js";
import { TENANT_SETTING } from "./tenancy.js";

/**
 * Issue 4.9 — FX and valuation service (migration 0010).
 *
 * Applies the REAL shipped chain (0000–0010) to PGlite and proves the
 * acceptance, in order:
 *   1. mixed EUR/JPY/BHD presets value into EUR with independently
 *      computed totals (identity + inverted seed legs, never a float);
 *   2. native amounts survive a base-currency change unchanged;
 *   3. uncovered rows (stale range, unsupported pair) report incomplete
 *      instead of a false total;
 *   4. retries and rebuilds never duplicate valuations;
 *   5. explicit manual dated rates value rows seeds cannot, with provenance;
 *   6. every valuation cites rate date/source/calculation version;
 *   7. checks/RLS/grants hold on the new tables.
 */

/** Independent reimplementation (plain BigInt, half-even) for cross-checks. */
function expectedMinor(amountMinor: string, rate: string, sourceExp: number, targetExp: number) {
  const [whole = "0", fraction = ""] = rate.split(".");
  const coeff = BigInt(`${whole}${fraction}`);
  const num = BigInt(amountMinor) * coeff * 10n ** BigInt(targetExp);
  const den = 10n ** BigInt(fraction.length) * 10n ** BigInt(sourceExp);
  const q = num / den;
  const rem = num % den;
  if (rem * 2n < den) return q.toString();
  if (rem * 2n > den) return (q + 1n).toString();
  return (q % 2n === 0n ? q : q + 1n).toString();
}

describe("fx valuation service (migration 0010)", () => {
  let pg!: PGlite;
  let wsA!: string;
  let wsB!: string;

  async function q<T>(sqlText: string, params: unknown[] = []): Promise<T[]> {
    const result =
      params.length > 0
        ? await pg.query<T>(sqlText, params as never[])
        : await pg.query<T>(sqlText);
    return result.rows;
  }

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

  const count = async (table: string, where = "", params: unknown[] = []) =>
    one(await q<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} ${where}`, params)).n;

  let eurTxn!: string;
  let jpyTxn!: string;
  let bhdTxn!: string;
  let gbpTxn!: string;
  let staleTxn!: string;

  beforeAll(async () => {
    pg = await createMigratedDb("0010_fx_valuation");
    const db = drizzlePglite(pg, { schema });
    wsA = one(await db.insert(workspaces).values({ name: "FX A" }).returning()).id;
    wsB = one(await db.insert(workspaces).values({ name: "FX B" }).returning()).id;
    const acct = one(
      await db
        .insert(accounts)
        .values({ workspaceId: wsA, name: "Everyday", currencyCode: "EUR" })
        .returning(),
    );
    const seed = async (
      amountMinor: number,
      currencyCode: string,
      effectiveDate: string,
      description: string,
    ) =>
      one(
        await db
          .insert(transactions)
          .values({
            workspaceId: wsA,
            accountId: acct.id,
            direction: "debit",
            amountMinor,
            currencyCode,
            effectiveDate,
            description,
          })
          .returning(),
      ).id;
    eurTxn = await seed(10000, "EUR", "2026-08-15", "EUR GROCERIES");
    jpyTxn = await seed(1500, "JPY", "2026-08-16", "TOKYO SHOP");
    bhdTxn = await seed(1234567, "BHD", "2026-08-17", "MANAMA STORE");
    gbpTxn = await seed(500, "GBP", "2026-08-18", "LONDON PUB");
    staleTxn = await seed(2000, "USD", "2025-06-01", "OLD TRIP");
  });

  afterAll(async () => {
    await pg.close();
  });

  it("creates the new tables and defaults base currency to EUR", async () => {
    const tables = await tableNames(pg);
    expect(tables).toContain("fx_rates");
    expect(tables).toContain("transaction_valuations");
    const db = drizzlePglite(pg, { schema });
    expect(await getBaseCurrency(db, wsA)).toBe("EUR");
    await expectDbError(
      q(
        `INSERT INTO fx_rates (workspace_id, base_currency_code, quote_currency_code, rate_date, rate, source)
         VALUES ($1, 'EUR', 'EUR', '2026-08-01', 1, 'seed')`,
        [wsA],
      ),
      /fx_rates_pair_check/,
    );
    await expectDbError(
      q(
        `INSERT INTO fx_rates (workspace_id, base_currency_code, quote_currency_code, rate_date, rate, source)
         VALUES ($1, 'EUR', 'JPY', '2026-08-01', 0, 'seed')`,
        [wsA],
      ),
      /fx_rates_rate_check/,
    );
    await expectDbError(
      q(
        `INSERT INTO fx_rates (workspace_id, base_currency_code, quote_currency_code, rate_date, rate, source)
         VALUES ($1, 'EUR', 'JPY', '2026-08-01', 170, 'ecb')`,
        [wsA],
      ),
      /fx_rates_source_check/,
    );
  });

  it("values the mixed fixture into EUR with provenance on every row", async () => {
    const db = drizzlePglite(pg, { schema });
    const result = await rebuildValuations(db, wsA);
    expect(result.targetCurrency).toBe("EUR");
    expect(result.calculationVersion).toBe("v1");
    expect(result.total).toBe(5);
    expect(result.valued).toBe(3);
    expect(result.missing.map((m) => m.transactionId).sort()).toEqual([gbpTxn, staleTxn].sort());

    const byTxn = new Map(
      (
        await db
          .select()
          .from(transactionValuations)
          .where(eq(transactionValuations.workspaceId, wsA))
      ).map((v) => [v.transactionId, v]),
    );
    // Identity: no external rate, exact passthrough. NUMERIC(30,15)
    // normalizes the stored form to 15dp; the VALUE stays exactly one.
    expect(byTxn.get(eurTxn)).toMatchObject({
      targetCurrencyCode: "EUR",
      rate: "1.000000000000000",
      rateDate: "2026-08-15",
      rateSource: "identity",
      convertedAmountMinor: 10000,
      calculationVersion: "v1",
    });
    // JPY 1500 at the inverted August anchor: 1500/177 = 8.4745… → €8.47.
    expect(byTxn.get(jpyTxn)).toMatchObject({
      rateDate: "2026-08-01",
      rateSource: "seed",
      convertedAmountMinor: 847,
    });
    // BHD cross-checked against the independent implementation.
    const bhd = byTxn.get(bhdTxn);
    expect(bhd?.rateDate).toBe("2026-08-01");
    expect(bhd?.rateSource).toBe("seed");
    expect(String(bhd?.convertedAmountMinor)).toBe(
      expectedMinor("1234567", bhd?.rate as string, 3, 2),
    );
  });

  it("reports stale and unsupported coverage instead of false totals", async () => {
    const db = drizzlePglite(pg, { schema });
    const result = await rebuildValuations(db, wsA, { transactionIds: [gbpTxn, staleTxn] });
    expect(result.valued).toBe(0);
    expect(result.missing).toHaveLength(2);
    const reasons = new Map(result.missing.map((m) => [m.transactionId, m.reason]));
    expect(reasons.get(gbpTxn)).toBe("unsupported-pair");
    expect(reasons.get(staleTxn)).toBe("rate-stale");
  });

  it("rebuilds and retries without duplicating valuations", async () => {
    const db = drizzlePglite(pg, { schema });
    const before = await count("transaction_valuations", "WHERE workspace_id = $1", [wsA]);
    const again = await rebuildValuations(db, wsA);
    expect(again.valued).toBe(3);
    expect(await count("transaction_valuations", "WHERE workspace_id = $1", [wsA])).toBe(before);
  });

  it("values manual-rate rows seeds cannot, idempotently", async () => {
    const db = drizzlePglite(pg, { schema });
    expect(
      await upsertManualRate(db, wsA, {
        base: "GBP",
        quote: "EUR",
        rateDate: "2026-08-01",
        rate: "1.17",
      }),
    ).toEqual({ created: true });
    expect(
      await upsertManualRate(db, wsA, {
        base: "GBP",
        quote: "EUR",
        rateDate: "2026-08-01",
        rate: "1.17",
      }),
    ).toEqual({ created: false });
    await expect(
      upsertManualRate(db, wsA, {
        base: "GBP",
        quote: "EUR",
        rateDate: "2026-08-01",
        rate: "1.18",
      }),
    ).rejects.toThrow(DomainError);

    const found = await lookupRate(db, wsA, "GBP", "EUR", "2026-08-18");
    expect(found).toMatchObject({
      rate: "1.170000000000000",
      rateDate: "2026-08-01",
      source: "manual",
    });
    const result = await rebuildValuations(db, wsA, { transactionIds: [gbpTxn] });
    expect(result.valued).toBe(1);
    expect(result.missing).toEqual([]);
    const row = one(
      await db
        .select()
        .from(transactionValuations)
        .where(eq(transactionValuations.transactionId, gbpTxn)),
    );
    expect(row.rateSource).toBe("manual");
    // 500 minor GBP × 1.17 = £5.00 → €5.85 = 585 minor.
    expect(row.convertedAmountMinor).toBe(585);
  });

  it("keeps native amounts intact across a base-currency change", async () => {
    const db = drizzlePglite(pg, { schema });
    expect(await setBaseCurrency(db, wsA, "BHD")).toBe("BHD");
    expect(await getBaseCurrency(db, wsA)).toBe("BHD");
    await expect(setBaseCurrency(db, wsA, "XXY")).rejects.toThrow(DomainError);
    const native = await db
      .select({
        id: transactions.id,
        amountMinor: transactions.amountMinor,
        currencyCode: transactions.currencyCode,
      })
      .from(transactions)
      .where(eq(transactions.workspaceId, wsA));
    expect(native.find((t) => t.id === jpyTxn)).toMatchObject({
      amountMinor: 1500,
      currencyCode: "JPY",
    });
    const rebuilt = await rebuildValuations(db, wsA, { transactionIds: [eurTxn] });
    expect(rebuilt.targetCurrency).toBe("BHD");
    expect(rebuilt.valued).toBe(1);
    // Old EUR valuations remain reproducible against their recorded version.
    expect(
      await count(
        "transaction_valuations",
        "WHERE transaction_id = $1 AND target_currency_code = 'EUR'",
        [eurTxn],
      ),
    ).toBe("1");
    await setBaseCurrency(db, wsA, "EUR");
  });

  it("RLS: tenants stay apart on rates and valuations", async () => {
    await asApp(wsA, async () => {
      expect(Number(await count("fx_rates"))).toBeGreaterThan(0);
    });
    await asApp(wsB, async () => {
      expect(await count("fx_rates")).toBe("0");
      expect(await count("transaction_valuations")).toBe("0");
      await expect(
        (async () =>
          q(
            `INSERT INTO fx_rates (workspace_id, base_currency_code, quote_currency_code, rate_date, rate, source)
             VALUES ($1, 'EUR', 'JPY', '2026-08-01', 170, 'seed')`,
            [wsA],
          ))(),
      ).rejects.toThrow(/row-level security/);
    });
    await asApp(null, async () => {
      expect(await count("fx_rates")).toBe("0");
      expect(await count("transaction_valuations")).toBe("0");
    });
    const grants = await q<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'moneo_app'
          AND table_name IN ('fx_rates','transaction_valuations')
        ORDER BY table_name, privilege_type`,
    );
    const byTable = new Map<string, string[]>();
    for (const g of grants) {
      byTable.set(g.table_name, [...(byTable.get(g.table_name) ?? []), g.privilege_type]);
    }
    for (const table of ["fx_rates", "transaction_valuations"]) {
      expect(byTable.get(table)).toEqual(
        expect.arrayContaining(["SELECT", "INSERT", "UPDATE", "DELETE"]),
      );
    }
  });
});

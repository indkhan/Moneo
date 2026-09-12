import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { isKnownCurrency } from "@moneo/shared/currencies";
import {
  CALCULATION_VERSION,
  FX_SEED_ANCHORS,
  checkCurrencyPair,
  convertMinorUnits,
  invertRate,
  parseDecimalRate,
  seedAnchorsFor,
  selectManualRate,
  selectPublishedRate,
  type SelectedRate,
} from "@moneo/finance";
import { DomainError } from "@moneo/shared/problem";
import type { Db } from "./client.js";
import { fxRates, transactionValuations, transactions, workspaces } from "./schema.js";
import type * as schema from "./schema.js";

/**
 * Issue 4.9 — valuation service over the versioned rate cache.
 *
 * Flow per transaction: identity when the currencies match (no rate row);
 * otherwise the latest manual dated rate wins over seed anchors (explicit
 * user provenance outranks synthetic coverage), then the seed policy from
 * `@moneo/finance/fx` applies. Anything without an eligible rate lands in
 * `missing` with a reason — aggregates and AI evidence must label partials
 * incomplete, never present them as full totals.
 *
 * Idempotency: valuation inserts use `onConflictDoNothing` on the
 * (transaction, target, rate date, source, version) unique, and seed
 * insertion is conflict-free too — retries and rebuilds converge without
 * duplicating rows. Native transaction rows are only ever SELECTed here.
 */

export type FxDb = Db | PgliteDatabase<typeof schema> | NodePgDatabase<typeof schema>;

export type MissingValuationReason = "no-rate" | "rate-stale" | "unsupported-pair";

export interface MissingValuation {
  transactionId: string;
  reason: MissingValuationReason;
}

export interface RebuildResult {
  targetCurrency: string;
  calculationVersion: string;
  total: number;
  valued: number;
  missing: MissingValuation[];
}

function fail(message: string): never {
  throw new DomainError("VALIDATION_FAILED", {
    detail: message,
    errors: [{ field: "fx", message }],
  });
}

function checkRateDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    fail(`Invalid rateDate (expected YYYY-MM-DD): ${value}.`);
  }
  return value;
}

export async function getBaseCurrency(db: FxDb, workspaceId: string): Promise<string> {
  const rows = await db
    .select({ baseCurrency: workspaces.baseCurrency })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return rows[0]?.baseCurrency ?? "EUR";
}

/**
 * Change the valuation target. Native rows are untouched; the caller
 * rebuilds valuations (which this module makes idempotent) so analytics
 * and forecasts pick up the new target without rewriting history.
 */
export async function setBaseCurrency(
  db: FxDb,
  workspaceId: string,
  currencyCode: string,
): Promise<string> {
  const code = currencyCode.toUpperCase();
  if (!isKnownCurrency(code)) {
    fail(`Unknown currency: ${currencyCode}.`);
  }
  await db.update(workspaces).set({ baseCurrency: code }).where(eq(workspaces.id, workspaceId));
  return code;
}

/**
 * Record an explicit user-supplied dated rate. Same payload twice returns
 * the existing row (idempotent retry); a conflicting value for the same
 * pair/date is rejected loudly instead of silently rewriting history.
 */
export async function upsertManualRate(
  db: FxDb,
  workspaceId: string,
  input: { base: string; quote: string; rateDate: string; rate: string },
): Promise<{ created: boolean }> {
  const base = input.base.toUpperCase();
  const quote = input.quote.toUpperCase();
  checkCurrencyPair(base, quote);
  const rateDate = checkRateDate(input.rateDate);
  parseDecimalRate(input.rate);
  const existing = await db
    .select()
    .from(fxRates)
    .where(
      and(
        eq(fxRates.workspaceId, workspaceId),
        eq(fxRates.baseCurrencyCode, base),
        eq(fxRates.quoteCurrencyCode, quote),
        eq(fxRates.rateDate, rateDate),
        eq(fxRates.source, "manual"),
      ),
    )
    .limit(1);
  const current = existing[0];
  if (current) {
    // NUMERIC(30,15) normalizes scale on write ("1.17" reads back as
    // "1.170000000000000"), so compare values, not text.
    const stored = parseDecimalRate(current.rate);
    const offered = parseDecimalRate(input.rate);
    const same =
      stored.coeff * 10n ** BigInt(offered.scale) === offered.coeff * 10n ** BigInt(stored.scale);
    if (!same) {
      throw new DomainError("INVARIANT_VIOLATION", {
        detail: `A manual rate for ${base}/${quote} on ${rateDate} already exists with a different value.`,
      });
    }
    return { created: false };
  }
  await db
    .insert(fxRates)
    .values({
      workspaceId,
      baseCurrencyCode: base,
      quoteCurrencyCode: quote,
      rateDate,
      rate: input.rate,
      source: "manual",
    })
    .onConflictDoNothing({
      target: [
        fxRates.workspaceId,
        fxRates.baseCurrencyCode,
        fxRates.quoteCurrencyCode,
        fxRates.rateDate,
        fxRates.source,
      ],
    });
  return { created: true };
}

/** Seed the synthetic anchors for one workspace; conflict-free on rerun. */
export async function ensureSeedRates(db: FxDb, workspaceId: string): Promise<number> {
  if (FX_SEED_ANCHORS.length === 0) {
    return 0;
  }
  const rows = await db
    .insert(fxRates)
    .values(
      FX_SEED_ANCHORS.map((anchor) => ({
        workspaceId,
        baseCurrencyCode: anchor.base,
        quoteCurrencyCode: anchor.quote,
        rateDate: anchor.rateDate,
        rate: anchor.rate,
        source: "seed",
      })),
    )
    .onConflictDoNothing({
      target: [
        fxRates.workspaceId,
        fxRates.baseCurrencyCode,
        fxRates.quoteCurrencyCode,
        fxRates.rateDate,
        fxRates.source,
      ],
    })
    .returning();
  return rows.length;
}

interface EligibleRate extends SelectedRate {
  /** True when the seed leg was stored inverted (quote/base anchor). */
  inverted: boolean;
}

/** Manual first (explicit provenance), then seed policy; null when neither applies. */
export async function lookupRate(
  db: FxDb,
  workspaceId: string,
  sourceCurrency: string,
  targetCurrency: string,
  requestedDate: string,
): Promise<EligibleRate | null> {
  const source = sourceCurrency.toUpperCase();
  const target = targetCurrency.toUpperCase();
  if (source === target) {
    return { rate: "1", rateDate: requestedDate, source: "identity", inverted: false };
  }
  if (!isKnownCurrency(source) || !isKnownCurrency(target)) {
    return null;
  }
  for (const direction of [
    { base: source, quote: target, inverted: false },
    { base: target, quote: source, inverted: true },
  ] as const) {
    const rows = await db
      .select()
      .from(fxRates)
      .where(
        and(
          eq(fxRates.workspaceId, workspaceId),
          eq(fxRates.baseCurrencyCode, direction.base),
          eq(fxRates.quoteCurrencyCode, direction.quote),
          lte(fxRates.rateDate, requestedDate),
        ),
      )
      .orderBy(desc(fxRates.rateDate))
      .limit(40);
    const manual = selectManualRate(
      requestedDate,
      rows
        .filter((r) => r.source === "manual")
        .map((r) => ({ rateDate: r.rateDate, rate: r.rate })),
    );
    if (manual) {
      return { ...manual, inverted: direction.inverted };
    }
    const seed = selectPublishedRate(
      requestedDate,
      rows.filter((r) => r.source === "seed").map((r) => ({ rateDate: r.rateDate, rate: r.rate })),
    );
    if (seed) {
      return { ...seed, inverted: direction.inverted };
    }
  }
  return null;
}

/**
 * Rebuild valuations for a workspace (all rows, or one subset) into the
 * target currency. Returns completeness metadata alongside the counts:
 * callers MUST surface `missing` as incomplete coverage, never as zero.
 */
export async function rebuildValuations(
  db: FxDb,
  workspaceId: string,
  options: { targetCurrency?: string; transactionIds?: readonly string[] } = {},
): Promise<RebuildResult> {
  const target = (options.targetCurrency ?? (await getBaseCurrency(db, workspaceId))).toUpperCase();
  if (!isKnownCurrency(target)) {
    fail(`Unknown currency: ${target}.`);
  }
  await ensureSeedRates(db, workspaceId);

  const filters = [eq(transactions.workspaceId, workspaceId)];
  if (options.transactionIds !== undefined) {
    const unique = [...new Set(options.transactionIds)];
    if (unique.length === 0) {
      return {
        targetCurrency: target,
        calculationVersion: CALCULATION_VERSION,
        total: 0,
        valued: 0,
        missing: [],
      };
    }
    filters.push(inArray(transactions.id, unique));
  }
  const rows = await db
    .select()
    .from(transactions)
    .where(and(...filters))
    .orderBy(asc(transactions.effectiveDate), asc(transactions.id));

  const missing: MissingValuation[] = [];
  let valued = 0;
  for (const row of rows) {
    const found = await lookupRate(db, workspaceId, row.currencyCode, target, row.effectiveDate);
    if (!found) {
      const pairSupported =
        row.currencyCode.toUpperCase() === target ||
        seedAnchorsFor(row.currencyCode, target).length > 0;
      missing.push({
        transactionId: row.id,
        reason: pairSupported ? "rate-stale" : "unsupported-pair",
      });
      continue;
    }
    const { rate, rateDate } =
      found.source === "identity" || !found.inverted
        ? found
        : { rate: invertRate(found.rate), rateDate: found.rateDate };
    const converted = convertMinorUnits(String(row.amountMinor), row.currencyCode, rate, target);
    await db
      .insert(transactionValuations)
      .values({
        workspaceId,
        transactionId: row.id,
        targetCurrencyCode: target,
        rate,
        rateDate,
        rateSource: found.source,
        convertedAmountMinor: Number(converted),
        calculationVersion: CALCULATION_VERSION,
      })
      .onConflictDoNothing({
        target: [
          transactionValuations.transactionId,
          transactionValuations.targetCurrencyCode,
          transactionValuations.rateDate,
          transactionValuations.rateSource,
          transactionValuations.calculationVersion,
        ],
      });
    valued += 1;
  }
  return {
    targetCurrency: target,
    calculationVersion: CALCULATION_VERSION,
    total: rows.length,
    valued,
    missing,
  };
}

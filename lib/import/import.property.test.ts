import { describe, expect, it } from "vitest";
import { checkProperty, fc } from "@/lib/property-check";
import { resolveBalances, type BalanceSnapshot, type BalanceTransaction } from "@/lib/finance/balances";
import { batchDecisions, stageImportRows } from "@/lib/import/batch";
import type { MappedRow } from "@/lib/import/csv";

const BEYOND_SAFE = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
const amount = fc.tuple(fc.oneof(fc.bigInt({ min: 0n, max: 1_000_000n }), fc.bigInt({ min: BEYOND_SAFE, max: 10n ** 30n })), fc.boolean())
  .map(([value, negative]) => (negative ? -value : value));
const currency = fc.constantFrom("EUR", "JPY", "KWD");
const text = fc.string({ minLength: 1, maxLength: 12 });

describe("importing a file keeps every source row", () => {
  const cells = fc.dictionary(text, text, { maxKeys: 3 });
  const fileRows = fc.array(fc.oneof(
    fc.record({ amountMinor: amount, currencyCode: currency, description: text, cells }).map(row => ({ excluded: false as const, ...row })),
    fc.record({ cells }).map(row => ({ excluded: true as const, ...row })),
  ), { minLength: 1, maxLength: 10 });

  it("staging loses no row, no digit and no original, and gives the same row the same identity every time", () => {
    checkProperty("staging keeps the source rows", fc.property(fileRows, fc.uuid(), (file, importId) => {
      const mapped: MappedRow[] = [];
      const excluded: { rowNumber: number; sourceRow: Record<string, string>; reason: string }[] = [];
      file.forEach((row, index) => {
        const rowNumber = index + 2;
        if (row.excluded) excluded.push({ rowNumber, sourceRow: row.cells, reason: "not a transaction" });
        else mapped.push({ accountName: "Main", rowNumber, postedOn: "2026-03-01", description: row.description, amountMinor: row.amountMinor, currencyCode: row.currencyCode,
          status: "posted", kind: "ordinary", reviewReasons: [], sourceRow: row.cells });
      });
      const accounts = new Map(["EUR", "JPY", "KWD"].map(code => [JSON.stringify(["Main", code]), `account-${code}`]));
      const staged = stageImportRows("workspace", importId, mapped, excluded, accounts, file.length);
      expect(staged).toHaveLength(file.length);
      staged.forEach((row, index) => {
        const source = file[index];
        expect(row.row.rowNumber).toBe(index + 2);
        expect(row.row.originalRow).toEqual(source.cells);
        expect(row.excluded).toBe(source.excluded);
        if (!source.excluded) expect(BigInt(row.row.amountMinor as string)).toBe(source.amountMinor);
      });
      expect(new Set(staged.map(row => row.row.sourceId)).size).toBe(file.length);
      expect(stageImportRows("workspace", importId, mapped, excluded, accounts, file.length).map(row => row.row.sourceId)).toEqual(staged.map(row => row.row.sourceId));
    }));
  });
});

describe("undoing an import", () => {
  const zone = "Europe/Amsterdam";
  const asOf = "2026-06-30T12:00:00.000Z";
  const account = { id: "account", name: "Main", currency_code: "EUR" };
  const earlier = fc.integer({ min: 1, max: 29 }).map(day => `2026-06-${String(day).padStart(2, "0")}T08:00:00.000Z`);
  const prior = fc.array(fc.record({ amount, as_of: earlier }), { maxLength: 3 }).map(rows => rows.map((row, index): BalanceSnapshot => ({
    id: `prior-${index}`, account_id: "account", amount_minor: row.amount.toString(), currency_code: "EUR", as_of: row.as_of, provenance: "manual", created_at: row.as_of })));
  const ledger = fc.array(fc.record({ amount, day: fc.integer({ min: 1, max: 30 }) }), { maxLength: 5 }).map(rows => rows.map((row, index): BalanceTransaction => ({
    id: `row-${index}`, account_id: "account", amount_minor: row.amount.toString(), currency_code: "EUR", posted_on: `2026-06-${String(row.day).padStart(2, "0")}`, status: "posted" })));
  const balances = (snapshots: BalanceSnapshot[], rows: BalanceTransaction[]) => resolveBalances([account], snapshots, rows, asOf, zone).map(item => item.balance);

  it("restores the balance from before the import and keeps the undone record out of every calculation", () => {
    checkProperty("undo restores the balance", fc.property(prior, ledger, amount, (snapshots, rows, importedAmount) => {
      const imported: BalanceSnapshot = { id: "imported", account_id: "account", amount_minor: importedAmount.toString(), currency_code: "EUR", as_of: asOf, provenance: "import", created_at: asOf };
      const importedRows: BalanceTransaction[] = [{ id: "imported-row", account_id: "account", amount_minor: "-1", currency_code: "EUR", posted_on: "2026-06-30", status: "posted" }];
      expect(balances([...snapshots, imported], [...rows, ...importedRows])[0].snapshot_amount_minor).toBe(importedAmount.toString());
      const undone = balances([...snapshots, { ...imported, undone_at: "2026-06-30T13:00:00.000Z" }], rows);
      expect(undone).toEqual(balances(snapshots, rows));
    }));
  });
});

describe("importing the same file again", () => {
  type Entry = { id: string; key: string; externalId?: string; amountMinor: bigint };
  type FileRow = { key: string; externalId?: string; amountMinor: bigint };
  const repeatedAmounts = fc.oneof(fc.constantFrom(-500n, 1999n, 123456789012345678901234n), amount);
  const file = fc.array(fc.record({ withBankId: fc.boolean(), amountMinor: repeatedAmounts }), { minLength: 1, maxLength: 14 })
    .map(rows => rows.map((row, index): FileRow => ({ key: row.amountMinor.toString(), amountMinor: row.amountMinor, ...(row.withBankId ? { externalId: `bank-${index}` } : {}) })));

  function importFile(ledger: Entry[], rows: FileRow[]) {
    const totals = new Map<string, number>();
    for (const row of rows) if (!row.externalId) totals.set(row.key, (totals.get(row.key) ?? 0) + 1);
    const seen = new Map<string, number>();
    const decisions = batchDecisions(rows.map((row, index) => {
      const matching = ledger.filter(entry => row.externalId ? entry.externalId === row.externalId : !entry.externalId && entry.key === row.key);
      if (!row.externalId) seen.set(row.key, (seen.get(row.key) ?? 0) + 1);
      const occurrence = row.externalId ? undefined : { index: seen.get(row.key)!, total: totals.get(row.key)! };
      return { rowNumber: index + 2, hasExternalId: Boolean(row.externalId), status: "posted" as const, ...(occurrence ? { occurrence } : {}),
        candidates: matching.map(entry => ({ id: entry.id, stableExternalMatch: Boolean(row.externalId), status: "posted" as const, version: 1 })) };
    }));
    const added = decisions.flatMap((decision, index) => decision.action === "new" ? [rows[index]] : [])
      .map((row, index): Entry => ({ id: `t${ledger.length + index}`, ...row }));
    return { ledger: [...ledger, ...added], reviews: decisions.filter(decision => decision.action === "review").length };
  }
  const total = (entries: { amountMinor: bigint }[]) => entries.reduce((sum, entry) => sum + entry.amountMinor, 0n);

  it("adds each transaction once, however often the file or an overlapping part of it is imported", () => {
    checkProperty("reimport never double counts", fc.property(file, fc.nat(14), (rows, cut) => {
      const earlierPart = rows.slice(0, Math.min(cut, rows.length));
      const first = importFile([], earlierPart);
      const full = importFile(first.ledger, rows);
      const again = importFile(full.ledger, rows);
      const thrice = importFile(again.ledger, rows);
      for (const result of [first, full, again, thrice]) expect(result.reviews).toBe(0);
      expect(first.ledger).toHaveLength(earlierPart.length);
      expect(full.ledger).toHaveLength(rows.length);
      expect(total(full.ledger)).toBe(total(rows));
      expect(thrice.ledger).toEqual(full.ledger);
    }));
  });
});

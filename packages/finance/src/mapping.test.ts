import { describe, expect, it } from "vitest";
import { DomainError } from "@moneo/shared/problem";
import {
  detectColumnMapping,
  normalizeHeader,
  parseDirectionToken,
  parseStatementAmount,
  parseStatementDate,
  previewMappedRows,
  resolveMapping,
  validateMapping,
  type ColumnMapping,
} from "./mapping.js";

/**
 * Issue 3.5 — statement column mapping.
 *
 * Proves, in order: header normalization (case, umlauts, punctuation);
 * auto-detection (EN + DE synonyms, exact vs partial confidence, each
 * column claimed once, unmapped indexes reported); validation (duplicate
 * columns, out-of-range indexes, amount-vs-split exclusivity, required
 * date/amount); manual overrides layered over detection; date parsing
 * (ISO, German dots, both slash orders, Excel serials, rejects); amount
 * parsing (both continental formats, grouping heuristics, signs and
 * parentheses to explicit direction, zero canonicalization, exact
 * minor units incl. JPY/BHD, overflow/precision rejection); direction
 * tokens (multilingual, unknown rejected); and the typed preview (happy
 * rows, per-row errors with line numbers, currency resolution, split
 * credit/debit, account handling, preview slicing).
 */

const row = (rowNumber: number, cells: string[]) => ({ rowNumber, cells });

function expectMappingError(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("VALIDATION_FAILED");
    return error as DomainError;
  }
  throw new Error("Expected a VALIDATION_FAILED DomainError, but validation passed");
}

describe("header normalization", () => {
  it("folds case, umlauts, and punctuation", () => {
    expect(normalizeHeader("Buchungs-Tag")).toBe("buchungstag");
    expect(normalizeHeader("Währung")).toBe("wahrung");
    expect(normalizeHeader("Empfänger")).toBe("empfanger");
    expect(normalizeHeader("Transaction Date")).toBe("transactiondate");
    expect(normalizeHeader("Soll/Haben")).toBe("sollhaben");
  });
});

describe("auto-detection", () => {
  it("maps a Revolut-style English header exactly", () => {
    const detected = detectColumnMapping([
      "Type",
      "Product",
      "Started Date",
      "Description",
      "Amount",
      "Currency",
    ]);
    // "Started Date" contains "date" (partial); the rest are exact.
    expect(detected.mapping.date).toBe(2);
    expect(detected.mapping.description).toBe(3);
    expect(detected.mapping.amount).toBe(4);
    expect(detected.mapping.currency).toBe(5);
    expect(detected.confidence.amount).toBe("exact");
    expect(detected.confidence.date).toBe("partial");
    expect(detected.unmapped).toEqual([0, 1]);
  });

  it("maps a German Commerzbank-style header", () => {
    const detected = detectColumnMapping(["Buchungstag", "Verwendungszweck", "Betrag", "Währung"]);
    expect(detected.mapping).toMatchObject({ date: 0, description: 1, amount: 2, currency: 3 });
  });

  it("claims each column at most once", () => {
    const detected = detectColumnMapping(["Amount", "Total Amount"]);
    const claimed = Object.values(detected.mapping).filter((c): c is number => c !== null);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(detected.mapping.amount).toBe(0);
  });

  it("detects credit/debit splits and direction columns", () => {
    const split = detectColumnMapping(["Datum", "Text", "Haben", "Soll"]);
    expect(split.mapping.credit).toBe(2);
    expect(split.mapping.debit).toBe(3);
    const dir = detectColumnMapping(["date", "memo", "amount", "Soll/Haben"]);
    expect(dir.mapping.direction).toBe(3);
  });

  it("leaves unknown headers unmapped with none confidence", () => {
    const detected = detectColumnMapping(["foo", "bar"]);
    expect(Object.values(detected.mapping).every((c) => c === null)).toBe(true);
    expect(detected.confidence.date).toBe("none");
    expect(detected.unmapped).toEqual([0, 1]);
  });
});

describe("validation", () => {
  const headers = ["date", "desc", "amount"];
  const valid: ColumnMapping = {
    date: 0,
    description: 1,
    amount: 2,
    credit: null,
    debit: null,
    currency: null,
    direction: null,
    account: null,
  };

  it("accepts a minimal valid mapping", () => {
    expect(() => {
      validateMapping(headers, valid);
    }).not.toThrow();
  });

  it("rejects duplicate and out-of-range columns", () => {
    expectMappingError(() => {
      validateMapping(headers, { ...valid, description: 0 });
    });
    expectMappingError(() => {
      validateMapping(headers, { ...valid, amount: 7 });
    });
  });

  it("rejects amount mixed with a credit/debit split", () => {
    expectMappingError(() => {
      validateMapping(headers, { ...valid, credit: 1 });
    });
  });

  it("requires date and some amount shape", () => {
    expectMappingError(() => {
      validateMapping(headers, { ...valid, date: null });
    });
    expectMappingError(() => {
      validateMapping(headers, { ...valid, amount: null });
    });
    // A lone credit column without its debit half is not a valid split.
    expectMappingError(() => {
      validateMapping(["date", "c", "d"], {
        ...valid,
        amount: null,
        description: null,
        credit: 1,
        debit: null,
      });
    });
  });
});

describe("manual overrides", () => {
  it("layers overrides over detection and revalidates", () => {
    const resolved = resolveMapping(["day", "note", "sum"], { date: 0, description: 1, amount: 2 });
    expect(resolved).toMatchObject({ date: 0, description: 1, amount: 2 });
    expectMappingError(() => resolveMapping(["day", "note", "sum"], { date: 0, amount: 0 }));
  });
});

describe("date parsing", () => {
  it("accepts ISO, German dots, both slash orders, and Excel serials", () => {
    expect(parseStatementDate("2026-02-01")).toBe("2026-02-01");
    expect(parseStatementDate("01.02.2026")).toBe("2026-02-01");
    expect(parseStatementDate("02/01/2026")).toBe("2026-02-01");
    expect(parseStatementDate("13/01/2026")).toBe("2026-01-13");
    expect(parseStatementDate("44927")).toBe("2023-01-01");
    expect(parseStatementDate(" 2026-03-04 ")).toBe("2026-03-04");
  });

  it("rejects impossible and unrecognized dates", () => {
    for (const bad of ["2026-13-01", "32.01.2026", "13/13/2026", "yesterday", "", "123"]) {
      expect(() => parseStatementDate(bad), bad).toThrow();
    }
  });
});

describe("amount parsing", () => {
  it("parses continental and Anglo formats to exact minor units", () => {
    expect(parseStatementAmount("12.50", "EUR")).toEqual({
      amountMinor: 1250n,
      direction: "credit",
    });
    expect(parseStatementAmount("1.234,56", "EUR")).toEqual({
      amountMinor: 123456n,
      direction: "credit",
    });
    expect(parseStatementAmount("1,234.56", "EUR")).toEqual({
      amountMinor: 123456n,
      direction: "credit",
    });
    expect(parseStatementAmount("1 234,56 €", "EUR")).toEqual({
      amountMinor: 123456n,
      direction: "credit",
    });
  });

  it("maps signs and parentheses to explicit direction, never signed amounts", () => {
    expect(parseStatementAmount("-12.50", "EUR")).toEqual({
      amountMinor: 1250n,
      direction: "debit",
    });
    expect(parseStatementAmount("(12.50)", "EUR")).toEqual({
      amountMinor: 1250n,
      direction: "debit",
    });
    expect(parseStatementAmount("+12.50", "EUR")).toEqual({
      amountMinor: 1250n,
      direction: "credit",
    });
    expect(parseStatementAmount("0.00", "EUR")).toEqual({ amountMinor: 0n, direction: "credit" });
  });

  it("reads grouping-only figures as whole units", () => {
    expect(parseStatementAmount("1,234", "EUR").amountMinor).toBe(123400n);
    expect(parseStatementAmount("1.234.567", "EUR").amountMinor).toBe(123456700n);
    expect(parseStatementAmount("1250", "EUR").amountMinor).toBe(125000n);
  });

  it("respects zero- and three-exponent currencies", () => {
    expect(parseStatementAmount("1500", "JPY")).toEqual({
      amountMinor: 1500n,
      direction: "credit",
    });
    expect(parseStatementAmount("1,500", "JPY")).toEqual({
      amountMinor: 1500n,
      direction: "credit",
    });
    // Grouping reading: 1234 dinars at 3 exponents.
    expect(parseStatementAmount("1.234", "BHD")).toEqual({
      amountMinor: 1234000n,
      direction: "credit",
    });
  });

  it("treats lone three-digit groups as thousands, rejects the ragged rest", () => {
    // Documented heuristic: "12.345" can only be twelve thousand (three
    // decimals would exceed EUR precision anyway).
    expect(parseStatementAmount("12.345", "EUR").amountMinor).toBe(1234500n);
    expect(() => parseStatementAmount("12.50.00", "EUR")).toThrow();
    expect(() => parseStatementAmount("12.3456", "EUR")).toThrow();
    expect(() => parseStatementAmount("abc", "EUR")).toThrow();
    expect(() => parseStatementAmount("", "EUR")).toThrow();
    expect(() => parseStatementAmount("12.50", "XXX")).toThrow();
  });
});

describe("direction tokens", () => {
  it("accepts multilingual credit/debit markers", () => {
    for (const token of ["credit", "C", "CR", "Haben", "H", "+"]) {
      expect(parseDirectionToken(token)).toBe("credit");
    }
    for (const token of ["debit", "D", "DR", "Soll", "S", "-"]) {
      expect(parseDirectionToken(token)).toBe("debit");
    }
  });

  it("rejects unknown markers", () => {
    expect(() => parseDirectionToken("maybe")).toThrow();
    expect(() => parseDirectionToken("")).toThrow();
  });
});

describe("typed preview", () => {
  const headers = ["Buchungstag", "Verwendungszweck", "Betrag", "Währung"];

  it("normalizes a clean German statement", () => {
    const mapping = resolveMapping(headers, { date: 0, description: 1, amount: 2, currency: 3 });
    const { preview, errors, totalRows } = previewMappedRows({
      headers,
      rows: [
        row(2, ["01.02.2026", "COFFEE BAR", "-3,50", "EUR"]),
        row(3, ["44927", "SALARY", "2.500,00", "EUR"]),
      ],
      mapping,
    });
    expect(errors).toEqual([]);
    expect(totalRows).toBe(2);
    expect(preview).toEqual([
      {
        rowNumber: 2,
        date: "2026-02-01",
        description: "COFFEE BAR",
        amountMinor: "350",
        currency: "EUR",
        direction: "debit",
        account: null,
      },
      {
        rowNumber: 3,
        date: "2023-01-01",
        description: "SALARY",
        amountMinor: "250000",
        currency: "EUR",
        direction: "credit",
        account: null,
      },
    ]);
  });

  it("lets a direction column override the amount sign", () => {
    const heads = ["date", "memo", "amount", "side"];
    const mapping = resolveMapping(heads, { date: 0, description: 1, amount: 2, direction: 3 });
    const { preview } = previewMappedRows({
      headers: heads,
      rows: [row(2, ["2026-01-01", "x", "10.00", "Soll"])],
      mapping,
    });
    expect(preview[0]).toMatchObject({ direction: "debit", amountMinor: "1000" });
  });

  it("supports credit/debit-split files", () => {
    const heads = ["date", "text", "in", "out"];
    const mapping = resolveMapping(heads, { date: 0, description: 1, credit: 2, debit: 3 });
    const { preview, errors } = previewMappedRows({
      headers: heads,
      rows: [
        row(2, ["2026-01-01", "pay", "100,00", ""]),
        row(3, ["2026-01-02", "shop", "", "25,00"]),
      ],
      mapping,
    });
    expect(errors).toEqual([]);
    expect(preview).toMatchObject([
      { direction: "credit", amountMinor: "10000" },
      { direction: "debit", amountMinor: "2500" },
    ]);
  });

  it("keeps row currencies per row and defaults the rest to EUR", () => {
    const mapping = resolveMapping(headers, { date: 0, description: 1, amount: 2, currency: 3 });
    const { preview } = previewMappedRows({
      headers,
      rows: [
        row(2, ["2026-01-01", "sushi", "1500", "JPY"]),
        row(3, ["2026-01-02", "tea", "3,50", ""]),
      ],
      mapping,
    });
    expect(preview[0]).toMatchObject({ currency: "JPY", amountMinor: "1500" });
    expect(preview[1]).toMatchObject({ currency: "EUR", amountMinor: "350" });
  });

  it("collects bad data as row errors with file line numbers", () => {
    const mapping = resolveMapping(headers, { date: 0, description: 1, amount: 2, currency: 3 });
    const { preview, errors, totalRows } = previewMappedRows({
      headers,
      rows: [
        row(2, ["not-a-date", "x", "1,00", "EUR"]),
        row(3, ["2026-01-01", "y", "nope", "EUR"]),
        row(4, ["2026-01-01", "z", "1,00", "XXX"]),
        row(5, ["2026-01-01", "ok", "1,00", "EUR"]),
      ],
      mapping,
    });
    expect(totalRows).toBe(4);
    expect(preview.map((r) => r.rowNumber)).toEqual([5]);
    expect(errors.map((e) => e.rowNumber)).toEqual([2, 3, 4]);
  });

  it("rejects a doubly-filled or empty credit/debit pair per row", () => {
    const heads = ["date", "text", "in", "out"];
    const mapping = resolveMapping(heads, { date: 0, description: 1, credit: 2, debit: 3 });
    const { errors } = previewMappedRows({
      headers: heads,
      rows: [row(2, ["2026-01-01", "x", "1,00", "2,00"]), row(3, ["2026-01-01", "y", "", ""])],
      mapping,
    });
    expect(errors).toHaveLength(2);
  });

  it("slices the preview but still reports the total", () => {
    const mapping = resolveMapping(headers, { date: 0, description: 1, amount: 2, currency: 3 });
    const rows = [1, 2, 3, 4].map((n) => row(n + 1, ["2026-01-01", `r${n}`, "1,00", "EUR"]));
    const { preview, totalRows } = previewMappedRows({ headers, rows, mapping, previewRows: 2 });
    expect(preview).toHaveLength(2);
    expect(totalRows).toBe(4);
  });

  it("throws for a bad mapping and a bad default currency, not for bad data", () => {
    const mapping = resolveMapping(headers, { date: 0, description: 1, amount: 2, currency: 3 });
    expect(() =>
      previewMappedRows({
        headers,
        rows: [],
        mapping: { ...mapping, amount: 9 },
      }),
    ).toThrow(DomainError);
    expect(() => previewMappedRows({ headers, rows: [], mapping, defaultCurrency: "XXX" })).toThrow(
      DomainError,
    );
  });
});

import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { compareReviewEvidence } from "./finance/review-freshness";
import { mapRows, parseAmountMinor, parseCsv, parseExcel, parseTransactionStatus, previewImport, validateMapping, validateAiMapping, proposeAccountRoutes, validateImportConfirmation } from "./csv";

const mapping = {
  accountName: "Checking",
  currencyCode: "EUR",
  dateColumn: "Date",
  descriptionColumn: "Description",
  amountColumn: "Amount",
  dateFormat: "dmy" as const,
  amountSign: "signed" as const,
  numericConvention: "decimal-dot" as const,
};

describe("financial import parsing", () => {
  it("rejects unpaired surrogates in source and reviewed mapping while preserving valid Unicode pairs", () => {
    const row = { Date: "01/09/2026", Description: "Valid", Amount: "1" };
    for (const invalid of ["\ud800", "\udfff", "\ud800x", "x\udfff"]) {
      expect(() => validateImportConfirmation([{ ...row, Evidence: invalid }], mapping)).toThrow("unpaired Unicode surrogate");
      expect(() => validateImportConfirmation([{ ...row, [invalid]: "Evidence" }], mapping)).toThrow("unpaired Unicode surrogate");
      for (const decision of [{ rowNumber: 2, action: "correct", values: { Description: "Corrected" } }, { rowNumber: 2, action: "exclude", reason: "Unsupported evidence" }]) {
        expect(() => validateImportConfirmation([{ ...row, Description: invalid }], { ...mapping, rowDecisions: [decision] })).toThrow("unpaired Unicode surrogate");
      }
      expect(() => validateImportConfirmation([row], { ...mapping, rowDecisions: [{ rowNumber: 2, action: "correct", values: { Description: invalid } }] })).toThrow("unpaired Unicode surrogate");
      expect(() => validateImportConfirmation([row], { ...mapping, rowDecisions: [{ rowNumber: 2, action: "correct", values: { [invalid]: "Corrected" } }] })).toThrow("unpaired Unicode surrogate");
      expect(() => validateImportConfirmation([row], { ...mapping, rowDecisions: [{ rowNumber: 2, action: "exclude", reason: invalid }] })).toThrow("unpaired Unicode surrogate");
      expect(() => validateImportConfirmation([row], { ...mapping, accountName: invalid })).toThrow("unpaired Unicode surrogate");
    }
    const valid = { ...row, Description: "Reviewed \ud83d\ude00", "Evidence \ud83d\ude00": "Original \ud83d\ude00" };
    const reviewed = validateImportConfirmation([valid], { ...mapping, rowDecisions: [{ rowNumber: 2, action: "correct", values: { Description: "Corrected \ud83d\ude00" } }] });
    expect(mapRows([valid], reviewed)[0]).toMatchObject({ description: "Corrected \ud83d\ude00", sourceRow: valid });
  });
  it("rejects an entire NUL-containing source before correction or exclusion can hide incompatible evidence", () => {
    const rows = [{ Date: "01/09/2026", Description: "Valid neighbor", Amount: "1" }, { Date: "02/09/2026", Description: "A\0B", Amount: "2" }];
    for (const rowDecisions of [undefined, [{ rowNumber: 3, action: "correct", values: { Description: "Corrected" } }], [{ rowNumber: 3, action: "exclude", reason: "Unsupported evidence" }]]) {
      expect(() => validateImportConfirmation(rows, { ...mapping, rowDecisions })).toThrow("NUL");
    }
    expect(() => parseCsv("Date,Description,Amount\n2026-09-01,Valid,1\n2026-09-02,A\0B,2")).toThrow("NUL");
    expect(() => validateImportConfirmation([{ Date: "01/09/2026", Description: "Valid", Amount: "1", "Source\0Key": "Original" }], mapping)).toThrow("NUL");
  });
  it("quarantines row-local CSV field-count errors while preserving valid neighbors and extra cells", () => {
    const input = { ...mapping, dateFormat: "iso" };
    for (const malformed of ["2026-09-02,Missing amount", "2026-09-02,Extra cell,2,unmapped evidence"]) {
      const rows = parseCsv(`Date,Description,Amount\n2026-09-01,Valid neighbor,1\n${malformed}`);
      const preview = previewImport(rows, input);
      expect(rows[1].__moneo_csv_field_count).toBe(malformed.includes("unmapped evidence") ? "4" : "2");
      expect(preview).toMatchObject({ totalRows: 2, acceptedRows: 1 });
      expect(preview.unresolvedRows.map(row => row.rowNumber)).toEqual([3]);
      expect(() => validateImportConfirmation(rows, input)).toThrow("field mismatch");
      const excluded = validateImportConfirmation(rows, { ...input, rowDecisions: [{ rowNumber: 3, action: "exclude", reason: "Malformed footer" }] });
      expect(mapRows(rows, excluded).map(row => row.description)).toEqual(["Valid neighbor"]);
      expect(() => validateImportConfirmation(rows, { ...input, rowDecisions: [{ rowNumber: 3, action: "correct", values: { Amount: "2" } }] })).toThrow("mapped cells");
      const corrected = validateImportConfirmation(rows, { ...input, rowDecisions: [{ rowNumber: 3, action: "correct", values: { Date: "2026-09-02", Description: "Reviewed posting", Amount: "2" } }] });
      expect(mapRows(rows, corrected)[1]).toMatchObject({ rowNumber: 3, description: "Reviewed posting", amountMinor: 200n, sourceRow: rows[1] });
      if (malformed.includes("unmapped evidence")) expect(JSON.stringify(rows[1])).toContain("unmapped evidence");
    }
    expect(() => parseCsv('Date,Description,Amount\n2026-09-01,Valid,1\n2026-09-02,"unclosed,2')).toThrow("CSV parse error");
  });
  it("keeps routed valid observations previewable when a footer has no currency", () => {
    const rows = [
      { Date: "01/09/2026", Description: "Posting", Amount: "1", Currency: "EUR", Product: "Current" },
      { Date: "", Description: "Footer", Amount: "1", Currency: "", Product: "" },
    ];
    const proposed = proposeAccountRoutes(rows, { ...mapping, currencyColumn: "Currency", productColumn: "Product" });
    const preview = previewImport(rows, proposed);
    expect(preview.acceptedRows).toBe(1);
    expect(preview.unresolvedRows.map(row => row.rowNumber)).toEqual([3]);
    expect(preview.unresolvedRows[0].sourceRow).toEqual(rows[1]);
  });
  it("quarantines escaped source evidence that would exceed the ingest record boundary", () => {
    const rows = [{ Date: "01/09/2026", Description: "Valid display", Amount: "1", Evidence: "\\".repeat(5_600_000) }];
    const preview = previewImport(rows, mapping);
    expect(preview.unresolvedRows).toHaveLength(1);
    expect(preview.unresolvedRows[0].message).toContain("record limit");
    expect(() => validateImportConfirmation(rows, mapping)).toThrow("record limit");
    expect(validateImportConfirmation(rows, { ...mapping, rowDecisions: [{ rowNumber: 2, action: "exclude", reason: "Oversized observation" }] })).toMatchObject({ rowContractVersion: "normalized-row-v1" });
  });
  it("does not infer fee treatment across an excluded observation", () => {
    const rows = [
      { Date: "2026-09-01T10:00:00Z", Description: "First", Amount: "-1", Balance: "100", Fee: "0" },
      { Date: "2026-09-01T11:00:00Z", Description: "Unresolved", Amount: "bad", Balance: "99", Fee: "0" },
      { Date: "2026-09-01T12:00:00Z", Description: "Last", Amount: "-10", Balance: "90", Fee: "1" },
    ];
    const preview = previewImport(rows, { ...mapping, dateFormat: "iso", balanceColumn: "Balance", feeColumn: "Fee",
      rowDecisions: [{ rowNumber: 3, action: "exclude", reason: "Unsupported source observation" }] });
    expect(preview.examples[1].feeEvidence).toEqual({ treatment: "unknown" });
  });
  it("freezes explicit corrections and exclusions without altering original evidence or row identity", () => {
    const rows = [
      { Date: "01/09/2026", Description: "First", Amount: "1" },
      { Date: "bad", Description: "Correction", Amount: "2" },
      { Date: "", Description: "Total", Amount: "3" },
      { Date: "02/09/2026", Description: "Last", Amount: "4" },
    ];
    const original = structuredClone(rows);
    const input = { ...mapping, rowDecisions: [
      { rowNumber: 3, action: "correct", values: { Date: "02/09/2026" } },
      { rowNumber: 4, action: "exclude", reason: "Statement summary, not a posting" },
    ] };
    const confirmed = validateImportConfirmation(rows, input);
    const preview = previewImport(rows, confirmed);
    expect(preview).toMatchObject({ totalRows: 4, acceptedRows: 3, correctedRows: 1, excludedRows: [{ rowNumber: 4, sourceRow: original[2] }], unresolvedRows: [] });
    expect(mapRows(rows, confirmed).map(row => row.rowNumber)).toEqual([2, 3, 5]);
    expect(mapRows(rows, confirmed)[1]).toMatchObject({ postedOn: "2026-09-02", sourceRow: original[1] });
    expect(rows).toEqual(original);
    expect(mapRows(rows, confirmed)).toEqual(mapRows(rows, confirmed));
  });
  it("rejects duplicate, unknown and out-of-range source review decisions", () => {
    const rows = [{ Date: "01/09/2026", Description: "First", Amount: "1" }];
    for (const rowDecisions of [
      [{ rowNumber: 9, action: "exclude", reason: "Footer" }],
      [{ rowNumber: 2, action: "exclude", reason: "Footer" }, { rowNumber: 2, action: "exclude", reason: "Footer" }],
      [{ rowNumber: 2, action: "correct", values: { Other: "1" } }],
    ]) expect(() => validateImportConfirmation(rows, { ...mapping, rowDecisions })).toThrow();
  });
  it("previews valid neighbors without hiding malformed, unsupported or footer observations", () => {
    const rows = [
      { Date: "01/09/2026", Description: "First", Amount: "1", State: "posted" },
      { Date: "02/09/2026", Description: "Unsupported", Amount: "2", State: "declined" },
      { Date: "03/09/2026", Description: "Last valid", Amount: "3", State: "posted" },
      { Date: "", Description: "Total", Amount: "6", State: "" },
    ];
    const input = { ...mapping, statusColumn: "State" };
    const preview = previewImport(rows, input);
    expect(preview.totalRows).toBe(4);
    expect(preview.acceptedRows).toBe(2);
    expect(preview.unresolvedRows.map(row => row.rowNumber)).toEqual([3, 5]);
    expect(preview.unresolvedRows.map(row => row.sourceRow)).toEqual([rows[1], rows[3]]);
    expect(preview.examples.map(row => row.rowNumber)).toEqual([2, 4]);
    expect(() => validateImportConfirmation(rows, input)).toThrow("Row 3");
  });
  it("rejects worker-incompatible description and account bounds before confirmation", () => {
    const row = { Date: "01/09/2026", Description: "x".repeat(501), Amount: "1" };
    expect(() => validateImportConfirmation([row], mapping)).toThrow("500");
    expect(() => mapRows([{ ...row, Description: "Valid" }], { ...mapping, accountName: "x".repeat(101) })).toThrow();
    const unicode = { ...row, Description: "😀".repeat(500) };
    expect(mapRows([unicode], mapping)[0].sourceRow).toEqual(unicode);
  });
  it("checks database bounds again after applying the reviewed outflow sign", () => {
    expect(() => validateImportConfirmation([{ Date: "01/09/2026", Description: "Valid", Amount: "-92233720368547758.08" }], { ...mapping, amountSign: "outflow-positive" })).toThrow("database range");
  });
  it("uses the declared decimal convention for small three-decimal currency amounts", () => {
    for (const currency of ["KWD", "BHD", "OMR"]) {
      for (const [separator, convention] of [[".", "decimal-dot"], [",", "decimal-comma"]] as const) {
        expect(parseAmountMinor(`1${separator}234`, currency, convention)).toBe(1234n);
        expect(parseAmountMinor(`-0${separator}123`, currency, convention)).toBe(-123n);
        expect(parseAmountMinor(`(0${separator}001)`, currency, convention)).toBe(-1n);
      }
    }
  });
  it("requires a convention for unresolved grouping and rejects conflicting source formats", () => {
    for (const currency of ["EUR", "JPY", "KWD"]) {
      expect(() => parseAmountMinor("1.234", currency)).toThrow("numeric convention");
      expect(parseAmountMinor("1.234", currency, "decimal-comma")).toBe(1234n * 10n ** BigInt(currency === "EUR" ? 2 : currency === "JPY" ? 0 : 3));
    }
    expect(() => parseAmountMinor("1,23", "EUR", "decimal-dot")).toThrow();
    expect(() => parseAmountMinor("1.234", "EUR", "decimal-dot")).toThrow();
  });
  it("does not let AI proposals claim a reviewed numeric convention or parser provenance", () => {
    const rows = [{ Date: "2026-09-01", Description: "Synthetic", Amount: "1" }];
    const proposed = validateAiMapping({ ...mapping, dateFormat: "iso", parserVersion: "numeric-convention-v2" }, rows, "EUR");
    expect(proposed.numericConvention).toBeUndefined();
    expect(proposed.parserVersion).toBeUndefined();
  });
  it("keeps preview, confirmation, source amount, fee and balance on the same convention", () => {
    const rows = [{ Date: "2026-09-01", Description: "Synthetic", Amount: "-0.123", Fee: "0.001", Balance: "1.234" }];
    const input = { ...mapping, currencyCode: "KWD", dateFormat: "iso", balanceColumn: "Balance", numericConvention: "decimal-dot" };
    const confirmed = validateImportConfirmation(rows, input);
    expect(confirmed).toMatchObject({ numericConvention: "decimal-dot", parserVersion: "numeric-convention-v2" });
    expect(previewImport(rows, confirmed).examples[0]).toMatchObject({ amountMinor: -123n, feeMinor: 1n, balanceMinor: 1234n, sourceRow: rows[0] });
    expect(mapRows(rows, confirmed)).toEqual(previewImport(rows, confirmed).examples);
    expect(() => validateImportConfirmation(rows, { ...input, numericConvention: undefined })).toThrow("numeric convention");
  });
  it("applies decimal-comma to debit/credit, fees and balances and blocks ambiguous optional money", () => {
    const rows = [{ Date: "2026-09-01", Description: "Synthetic", Debit: "0,123", Credit: "", Fee: "0,001", Balance: "1,234" }];
    const input = { ...mapping, amountColumn: undefined, debitColumn: "Debit", creditColumn: "Credit", currencyCode: "OMR", dateFormat: "iso", balanceColumn: "Balance", numericConvention: "decimal-comma" };
    expect(mapRows(rows, input)[0]).toMatchObject({ amountMinor: -123n, feeMinor: 1n, balanceMinor: 1234n, sourceRow: rows[0] });
    for (const column of ["Fee", "Balance"]) {
      const source = [{ Date: "2026-09-01", Description: "Synthetic", Amount: "1", [column]: "0.123" }];
      expect(() => mapRows(source, { ...mapping, numericConvention: undefined, dateFormat: "iso", ...(column === "Balance" ? { balanceColumn: "Balance" } : {}) })).toThrow("numeric convention");
    }
  });
  it("retains source evidence while a repaired interpretation makes a saved review stale", () => {
    const rows = [{ Date: "2026-09-01", Description: "Synthetic", Amount: "-0.123", Balance: "1.234" }];
    const original = structuredClone(rows);
    const repaired = mapRows(rows, validateImportConfirmation(rows, { ...mapping, currencyCode: "KWD", dateFormat: "iso", balanceColumn: "Balance" }))[0];
    const saved = { accounts: [{ currencyCode: "KWD", balanceMinor: "1234000" }], transactions: [{ amountMinor: "-123000" }] };
    const current = { accounts: [{ currencyCode: "KWD", balanceMinor: repaired.balanceMinor!.toString() }], transactions: [{ amountMinor: repaired.amountMinor.toString() }] };
    expect(compareReviewEvidence(saved, current).status).toBe("stale");
    expect(rows).toEqual(original);
    expect(repaired.sourceRow).toEqual(original[0]);
    expect(saved.accounts[0].balanceMinor).toBe("1234000");
  });
  it("rejects duplicate financial headers even when the CSV parser renames them", () => {
    expect(() => parseCsv("Date,Description,Amount,Amount\n2026-09-01,Shop,-12.50,-1250")).toThrow("Duplicate CSV headers");
  });
  it("recognizes booked bank debits while keeping transfers and ambiguous cash reviewable", () => {
    const rows = parseCsv("Date,Description,Amount,Type\n2026-09-01,Card debit,-12.50,Debit\n2026-09-02,Direct debit,-30.00,Debit\n2026-09-03,Incoming movement,100.00,Transfer (realtime)\n2026-09-04,Cash movement,-20.00,Cash deposit/withdrawal\n2026-09-05,Unexpected debit credit,10.00,Debit");
    const mapped = mapRows(rows, { ...mapping, dateFormat: "iso" });
    expect(mapped.map(row => ({ kind: row.kind, reviewReasons: row.reviewReasons }))).toEqual([
      { kind: "ordinary", reviewReasons: [] },
      { kind: "ordinary", reviewReasons: [] },
      { kind: "ordinary", reviewReasons: ["source_transfer"] },
      { kind: "ordinary", reviewReasons: ["source_type"] },
      { kind: "ordinary", reviewReasons: ["source_type"] },
    ]);
    expect(mapped.map(row => row.sourceRow)).toEqual(rows);
  });
  it("requires reviewed timezone for new naive timestamps and preserves dated source evidence", () => {
    const rows = parseCsv("Date,Description,Amount\n2026-09-30 22:30:00,Shop,-12.50");
    expect(() => validateImportConfirmation(rows, { ...mapping, dateFormat: "iso" })).toThrow("timezone");
    const confirmed = { ...mapping, dateFormat: "iso", timestampTimezone: "UTC", timestampTimezoneConfirmed: true };
    expect(mapRows(rows, confirmed)[0]).toMatchObject({ postedOn: "2026-10-01", postedAt: "2026-09-30T22:30:00.000Z", sourceRow: rows[0] });
    expect(() => validateImportConfirmation(rows, { ...confirmed, timestampTimezoneConfirmed: false })).toThrow("timezone");
    expect(validateImportConfirmation(rows, confirmed)).toBeDefined();
  });
  it("does not guess repeated or nonexistent Berlin local DST timestamps", () => {
    for (const date of ["2026-10-25 02:30:00", "2026-03-29 02:30:00"]) {
      expect(() => mapRows([{ Date: date, Description: "Shop", Amount: "-12.50" }], { ...mapping, dateFormat: "iso", timestampTimezone: "Europe/Berlin", timestampTimezoneConfirmed: true })).toThrow("ambiguous or nonexistent");
    }
  });
  it("validates chronological account balance deltas and fee evidence without file-order guesses", () => {
    const rows = parseCsv("Date,Description,Amount,Balance,Fee\n2026-09-01 12:00:00,Second,-5.00,95.00,1.00\n2026-09-01 10:00:00,First,100.00,100.00,0\n2026-09-01 14:00:00,Third,-10.00,83.00,2.00");
    const mapped = mapRows(rows, { ...mapping, dateFormat: "iso", balanceColumn: "Balance", timestampTimezone: "UTC", timestampTimezoneConfirmed: true });
    expect(mapped[0].feeEvidence).toMatchObject({ treatment: "included", deltaMinor: -500n, previousRowNumber: 3 });
    expect(mapped[2].feeEvidence).toMatchObject({ treatment: "additional", deltaMinor: -1200n, previousRowNumber: 2 });
    const tied = mapRows([{ ...rows[0], Date: rows[1].Date }, rows[1]], { ...mapping, dateFormat: "iso", balanceColumn: "Balance", timestampTimezone: "UTC", timestampTimezoneConfirmed: true });
    expect(tied[0].feeEvidence?.treatment).toBe("unknown");
  });
  it("keeps unsupported optional fee evidence reviewable without dropping valid booked money", () => {
    const rows = parseCsv("Date,Description,Amount,Type,Fee\n2026-09-01,Shop,-12.50,Card Payment,N/A");
    expect(mapRows(rows, { ...mapping, dateFormat: "iso" })[0]).toMatchObject({ amountMinor: -1250n, reviewReasons: ["fee_semantics"], sourceRow: rows[0] });
  });
  it("preserves uncertain type and fee evidence without inventing an internal transfer or fee", () => {
    const rows = parseCsv("Date,Description,Amount,Type,Fee\n2026-09-01,Movement,-12.50,Transfer,0\n2026-09-02,Returned purchase,1.25,Card Refund,0\n2026-09-03,Conversion,-100,Exchange,2.00\n2026-09-04,Refund reversal,-1.25,Card Refund,0");
    const mapped = mapRows(rows, { ...mapping, dateFormat: "iso" });
    expect(mapped).toMatchObject([
      { kind: "ordinary", reviewReasons: ["source_transfer"], amountMinor: -1250n },
      { kind: "refund", reviewReasons: [], amountMinor: 125n },
      { kind: "ordinary", feeMinor: 200n, reviewReasons: ["source_exchange", "fee_semantics"], amountMinor: -10000n },
      { kind: "ordinary", reviewReasons: ["refund_sign"], amountMinor: -125n },
    ]);
    expect(mapped.map(row => row.sourceRow)).toEqual(rows);
    expect(previewImport(rows, { ...mapping, dateFormat: "iso" }).classificationReviewRows).toBe(3);
  });
  it("normalizes completed but refuses failed or reverted source states", () => {
    expect(parseTransactionStatus("COMPLETED")).toBe("posted");
    expect(() => parseTransactionStatus("FAILED")).toThrow("Invalid status");
    expect(() => parseTransactionStatus("REVERTED")).toThrow("Invalid status");
    const rows = parseCsv("Date,Description,Amount,State\n2026-09-01,Purchase,-12.50,FAILED");
    expect(() => mapRows(rows, { ...mapping, dateFormat: "iso" })).toThrow("State");
  });
  it("proposes distinct routes for review from every row rather than a sample", () => {
    const rows = parseCsv("Date,Description,Amount,Product,Currency\n2026-09-01,Purchase,-12.50,Current,EUR\n2026-09-02,Interest,1.25,Savings,EUR");
    const proposed = proposeAccountRoutes(rows, { ...mapping, dateFormat: "iso", currencyColumn: "Currency" });
    expect(proposed.productColumn).toBe("Product");
    expect(proposed.accountRoutes?.map(route => route.accountName)).toEqual(["Checking · Current", "Checking · Savings"]);
    expect(mapRows(rows, proposed).map(row => row.accountName)).toEqual(["Checking · Current", "Checking · Savings"]);
  });

  it("routes every product and currency explicitly and preserves evidence", () => {
    const rows = parseCsv("Date,Description,Amount,Product,Currency,State\n2026-09-01,Purchase,-12.50,Current,EUR,COMPLETED\n2026-09-02,Interest,1.25,Savings,EUR,COMPLETED\n2026-09-03,Purchase,-100,Current,JPY,PENDING");
    const routed = { ...mapping, dateFormat: "iso", productColumn: "Product", currencyColumn: "Currency", statusColumn: "State", accountRoutes: [
      { productValue: "Current", currencyCode: "EUR", accountName: "Everyday" },
      { productValue: "Savings", currencyCode: "EUR", accountName: "Reserve" },
      { productValue: "Current", currencyCode: "JPY", accountName: "Yen" },
    ] };
    expect(mapRows(rows, routed)).toMatchObject([
      { accountName: "Everyday", amountMinor: -1250n, status: "posted", sourceRow: rows[0] },
      { accountName: "Reserve", amountMinor: 125n, status: "posted" },
      { accountName: "Yen", amountMinor: -100n, status: "pending", currencyCode: "JPY" },
    ]);
    expect(previewImport(rows, routed).accounts).toEqual([
      { accountName: "Everyday", currencyCode: "EUR", rows: 1 },
      { accountName: "Reserve", currencyCode: "EUR", rows: 1 },
      { accountName: "Yen", currencyCode: "JPY", rows: 1 },
    ]);
    expect(() => mapRows(rows, { ...routed, accountRoutes: routed.accountRoutes.slice(0, 2) })).toThrow("Review account routing");
    expect(() => mapRows(rows, { ...routed, accountRoutes: [...routed.accountRoutes, routed.accountRoutes[0]] })).toThrow("Review account routing");
    expect(() => mapRows(rows, { ...mapping, dateFormat: "iso", currencyColumn: "Currency" })).toThrow("Product");
  });
  it("parses exact minor units from regional formats", () => {
    expect(parseAmountMinor("€1.234,56")).toBe(123456n);
    expect(parseAmountMinor("(1,234.56)")).toBe(-123456n);
    expect(parseAmountMinor("0.01")).toBe(1n);
    expect(parseAmountMinor("1,234", "EUR", "decimal-dot")).toBe(123400n);
    expect(() => parseAmountMinor("1.2345")).toThrow();
    expect(parseAmountMinor("90071992547409.92", "EUR")).toBe(9007199254740992n);
    expect(parseAmountMinor("-92233720368547758.08", "EUR")).toBe(-9223372036854775808n);
    expect(() => parseAmountMinor("92233720368547758.08", "EUR")).toThrow("database range");
  });

  it("parses EUR (2 digits) and JPY (0 digits) correctly", () => {
    expect(parseAmountMinor("1.234,56", "EUR")).toBe(123456n);
    expect(parseAmountMinor("1,234.56", "EUR")).toBe(123456n);
    expect(parseAmountMinor("1000", "EUR")).toBe(100000n);
    expect(parseAmountMinor("1000", "JPY")).toBe(1000n);
    expect(parseAmountMinor("1,000", "JPY", "decimal-dot")).toBe(1000n);
    expect(parseAmountMinor("(1,000)", "JPY", "decimal-dot")).toBe(-1000n);
    expect(() => parseAmountMinor("1000.00", "JPY")).toThrow();
    expect(() => parseAmountMinor("1000,00", "JPY")).toThrow();
    expect(() => parseAmountMinor("0.01", "JPY")).toThrow();
  });

  it("parses KRW (0 digits) and KWD (3 digits) correctly", () => {
    expect(parseAmountMinor("1,000", "KRW", "decimal-dot")).toBe(1000n);
    expect(parseAmountMinor("(1,000)", "KRW", "decimal-dot")).toBe(-1000n);
    expect(() => parseAmountMinor("1000.00", "KRW")).toThrow();
    expect(() => parseAmountMinor("0.01", "KRW")).toThrow();

    expect(parseAmountMinor("1.234,567", "KWD")).toBe(1234567n);
    expect(parseAmountMinor("1,234.567", "KWD")).toBe(1234567n);
    expect(parseAmountMinor("1000", "KWD")).toBe(1000000n);
    expect(parseAmountMinor("1.234,56", "KWD")).toBe(1234560n);
    expect(parseAmountMinor("1000.0", "KWD")).toBe(1000000n);
  });

  it("validates mapping and preserves original rows", () => {
    const rows = parseCsv("Date,Description,Amount\n31.08.2026,Coffee,2.49\n01.09.2026,Salary,1500.00");
    expect(mapRows(rows, mapping)).toMatchObject([
      { postedOn: "2026-08-31", amountMinor: 249n, sourceRow: rows[0] },
      { postedOn: "2026-09-01", amountMinor: 150000n, sourceRow: rows[1] },
    ]);
    expect(previewImport(rows, mapping).dateRange).toEqual({ from: "2026-08-31", to: "2026-09-01" });
    expect(() => validateMapping({ ...mapping, amountColumn: "Wrong" }, rows)).toThrow("Unknown column");
    expect(() => validateMapping({ ...mapping, debitColumn: "Amount" }, rows)).toThrow();
    expect(() => mapRows(rows, { ...mapping, dateFormat: "iso" })).toThrow("Row 2");
  });

  it("accepts bank statement ISO timestamps as transaction dates", () => {
    const rows = parseCsv("Completed Date,Description,Amount\n2025-11-10 17:04:58,Transfer,100.00");
    const timestampMapping = { ...mapping, dateColumn: "Completed Date", dateFormat: "iso" as const };
    expect(mapRows(rows, timestampMapping)[0].postedOn).toBe("2025-11-10");
    expect(() => mapRows(parseCsv("Completed Date,Description,Amount\n2025-11-10 27:04:58,Transfer,100.00"), timestampMapping)).toThrow("Invalid date");
  });

  it("uses workspace currency when AI has no currency column", () => {
    const rows = parseCsv("Date,Description,Amount\n2026-08-01,Salary,2500.00");
    expect(validateAiMapping({ ...mapping, dateFormat: "iso", currencyCode: "USD" }, rows, "EUR").currencyCode).toBe("EUR");
  });

  it("maps debit and credit without changing signs", () => {
    const rows = parseCsv("Date,Description,Debit,Credit\n2026-09-01,Rent,900,\n2026-09-02,Salary,,2000");
    const base: Partial<typeof mapping> = { ...mapping };
    delete base.amountColumn;
    const mapped = mapRows(rows, { ...base, dateFormat: "iso", debitColumn: "Debit", creditColumn: "Credit" });
    expect(mapped.map((r) => r.amountMinor)).toEqual([-90000n, 200000n]);
  });

  it("uses row currency for amount parsing when currencyColumn is mapped", () => {
    const rows = parseCsv("Date,Description,Amount,Currency\n2026-09-01,Coffee EUR,2.49,EUR\n2026-09-02,Coffee JPY,249,JPY");
    const jpyMapping = { accountName: "Checking", currencyCode: "EUR", dateColumn: "Date", descriptionColumn: "Description", amountColumn: "Amount", dateFormat: "iso" as const, amountSign: "signed" as const, currencyColumn: "Currency" };
    const mapped = mapRows(rows, jpyMapping);
    expect(mapped[0].currencyCode).toBe("EUR");
    expect(mapped[0].amountMinor).toBe(249n);
    expect(mapped[1].currencyCode).toBe("JPY");
    expect(mapped[1].amountMinor).toBe(249n);
  });

  it("uses row currency for debit/credit parsing when currencyColumn is mapped", () => {
    const rows = parseCsv("Date,Description,Debit,Credit,Currency\n2026-09-01,Rent EUR,900,,EUR\n2026-09-02,Salary JPY,,200000,JPY");
    const jpyMapping = { accountName: "Checking", currencyCode: "EUR", dateColumn: "Date", descriptionColumn: "Description", debitColumn: "Debit", creditColumn: "Credit", dateFormat: "iso" as const, amountSign: "signed" as const, currencyColumn: "Currency" };
    const mapped = mapRows(rows, jpyMapping);
    expect(mapped[0].currencyCode).toBe("EUR");
    expect(mapped[0].amountMinor).toBe(-90000n);
    expect(mapped[1].currencyCode).toBe("JPY");
    expect(mapped[1].amountMinor).toBe(200000n);
  });

  it("uses row currency for balance parsing when currencyColumn is mapped", () => {
    const rows = parseCsv("Date,Description,Amount,Currency,Balance\n2026-09-01,Coffee,2.49,EUR,100.00\n2026-09-02,Salary,249,JPY,50000");
    const jpyMapping = { accountName: "Checking", currencyCode: "EUR", dateColumn: "Date", descriptionColumn: "Description", amountColumn: "Amount", dateFormat: "iso" as const, amountSign: "signed" as const, currencyColumn: "Currency", balanceColumn: "Balance" };
    const mapped = mapRows(rows, jpyMapping);
    expect(mapped[0].balanceMinor).toBe(10000n);
    expect(mapped[1].balanceMinor).toBe(50000n);
  });

  it("defaults to posted and only accepts an explicit posted/pending column", () => {
    const rows = parseCsv("Date,Description,Amount\n31.08.2026,Coffee,2.49");
    expect(mapRows(rows, mapping)[0].status).toBe("posted");
    expect(parseTransactionStatus(undefined)).toBe("posted");
    expect(parseTransactionStatus("")).toBe("posted");
    expect(parseTransactionStatus("Pending")).toBe("pending");
    expect(parseTransactionStatus("POSTED")).toBe("posted");
    expect(() => parseTransactionStatus("settled")).toThrow("Invalid status");
    const withStatus = parseCsv("Date,Description,Amount,Status\n31.08.2026,Coffee,2.49,pending\n01.09.2026,Salary,1500.00,posted");
    const mapped = mapRows(withStatus, { ...mapping, statusColumn: "Status" });
    expect(mapped.map((r) => r.status)).toEqual(["pending", "posted"]);
    expect(mapped[0].sourceRow).toMatchObject({ Status: "pending" });
    const preview = previewImport(withStatus, { ...mapping, statusColumn: "Status" });
    expect(preview.pendingRows).toBe(1);
    expect(preview.postedRows).toBe(1);
    expect(preview.examples[0].status).toBe("pending");
    expect(() => mapRows(withStatus, { ...mapping, statusColumn: "Missing" })).toThrow("Unknown column");
    const bad = parseCsv("Date,Description,Amount,Status\n31.08.2026,Coffee,2.49,unknown");
    expect(() => mapRows(bad, { ...mapping, statusColumn: "Status" })).toThrow("Row 2");
  });

  it("reads XLSX cells under their actual headers", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("transactions");
    sheet.addRow(["Date", "Description", "Amount"]);
    sheet.addRow([new Date("2026-09-01T00:00:00Z"), "Coffee", "-2.49"]);
    const bytes = await workbook.xlsx.writeBuffer();
    const rows = await parseExcel(bytes as ArrayBuffer);
    expect(rows).toEqual([{ Date: "2026-09-01", Description: "Coffee", Amount: "-2.49" }]);
    expect(mapRows(rows, { ...mapping, dateFormat: "iso" })[0].amountMinor).toBe(-249n);
  });
});

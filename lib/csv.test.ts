import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { mapRows, parseAmountMinor, parseCsv, parseExcel, parseTransactionStatus, previewImport, validateMapping, validateAiMapping, proposeAccountRoutes, validateImportConfirmation } from "./csv";

const mapping = {
  accountName: "Checking",
  currencyCode: "EUR",
  dateColumn: "Date",
  descriptionColumn: "Description",
  amountColumn: "Amount",
  dateFormat: "dmy" as const,
  amountSign: "signed" as const,
};

describe("financial import parsing", () => {
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
    expect(parseAmountMinor("1,234")).toBe(123400n);
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
    expect(parseAmountMinor("1,000", "JPY")).toBe(1000n);
    expect(parseAmountMinor("(1,000)", "JPY")).toBe(-1000n);
    expect(() => parseAmountMinor("1000.00", "JPY")).toThrow();
    expect(() => parseAmountMinor("1000,00", "JPY")).toThrow();
    expect(() => parseAmountMinor("0.01", "JPY")).toThrow();
  });

  it("parses KRW (0 digits) and KWD (3 digits) correctly", () => {
    expect(parseAmountMinor("1,000", "KRW")).toBe(1000n);
    expect(parseAmountMinor("(1,000)", "KRW")).toBe(-1000n);
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

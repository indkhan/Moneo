import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { mapRows, parseAmountMinor, parseCsv, parseExcel, parseTransactionStatus, previewImport, validateMapping } from "./csv";

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
  it("parses exact minor units from regional formats", () => {
    expect(parseAmountMinor("€1.234,56")).toBe(123456n);
    expect(parseAmountMinor("(1,234.56)")).toBe(-123456n);
    expect(parseAmountMinor("0.01")).toBe(1n);
    expect(parseAmountMinor("1,234")).toBe(123400n);
    expect(() => parseAmountMinor("1.2345")).toThrow();
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

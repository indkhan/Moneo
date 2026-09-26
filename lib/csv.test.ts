import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { mapRows, parseAmountMinor, parseCsv, parseExcel, previewImport, validateMapping } from "./csv";

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
    const { amountColumn: _amountColumn, ...base } = mapping;
    const mapped = mapRows(rows, { ...base, dateFormat: "iso", debitColumn: "Debit", creditColumn: "Credit" });
    expect(mapped.map((r) => r.amountMinor)).toEqual([-90000n, 200000n]);
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

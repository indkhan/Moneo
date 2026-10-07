import { expect, it } from "vitest";
import ExcelJS from "exceljs";
import { inspectExcel, inspectRows, mapRows, parseExcel } from "./csv";

async function workbookFixture() {
  const book = new ExcelJS.Workbook();
  book.addWorksheet("Summary").addRows([["Label", "Value"], ["Account count", "2"]]);
  const first = book.addWorksheet("Checking");
  first.addRows([["Statement header"], [], ["Date", "Description", "Amount"], [new Date("2026-09-01T14:25:30Z"), "Synthetic checking", "-12.34"]]);
  const second = book.addWorksheet("Savings");
  second.addRows([["Date", "Description", "Amount"], ["2026-09-02", "Synthetic savings", "20.00"]]);
  book.addWorksheet("Hidden", {state: "hidden"}).addRows([["Date", "Description", "Amount"], ["2026-09-02", "Excluded hidden", "999.00"]]);
  return {bytes: await book.xlsx.writeBuffer(), first: first.id, second: second.id};
}

it("requires explicit worksheet scope rather than silently using the first sheet", async () => {
  const {bytes} = await workbookFixture();
  await expect(parseExcel(bytes as ArrayBuffer)).rejects.toThrow(/select|scope|worksheet/i);
});

it("selects reviewed tables from two financial sheets and retains native timestamp evidence", async () => {
  const {bytes, first, second} = await workbookFixture();
  const rows = await parseExcel(bytes as ArrayBuffer, {version: "xlsx-scope-v1", tables: [{sheetId: first, headerRow: 3, endRow: 4}, {sheetId: second, headerRow: 1, endRow: 2}]});
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({Date: "2026-09-01T14:25:30", Description: "Synthetic checking", Amount: "-12.34"});
  expect(rows[1]).toMatchObject({Description: "Synthetic savings", Amount: "20.00"});
  const mapped = mapRows(rows, {accountName: "Synthetic",currencyCode: "EUR",dateColumn: "Date",descriptionColumn: "Description",amountColumn: "Amount",dateFormat: "iso",amountSign: "signed",numericConvention: "decimal-dot",timestampTimezone: "Europe/Berlin",timestampTimezoneConfirmed: true});
  expect(mapped[0].postedAt).toBe("2026-09-01T12:25:30.000Z");
  expect(mapped.map(row => row.amountMinor)).toEqual([-1234n,2000n]);
  expect(rows[0].__moneo_csv_xlsx_source).toContain('"sheetId":2');
  expect(rows[0].__moneo_csv_xlsx_source).toContain('2026-09-01T14:25:30.000Z');
});

it("keeps fractional native timestamps through reviewed timezone conversion", async () => {
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet("Time");
  sheet.addRows([["Date","Description","Amount"],[new Date("2026-09-01T14:25:30.123Z"),"Synthetic fractional time","-1.00"]]);
  const rows = await parseExcel(await book.xlsx.writeBuffer() as ArrayBuffer, {version: "xlsx-scope-v1",tables: [{sheetId: sheet.id,headerRow: 1,endRow: 2}]});
  const mapped = mapRows(rows,{accountName: "Synthetic",currencyCode: "EUR",dateColumn: "Date",descriptionColumn: "Description",amountColumn: "Amount",dateFormat: "iso",amountSign: "signed",numericConvention: "decimal-dot",timestampTimezone: "Europe/Berlin",timestampTimezoneConfirmed: true});
  expect(mapped[0].postedAt).toBe("2026-09-01T12:25:30.123Z");
});

it("quarantines unsafe numeric money cells while retaining valid neighbours and source evidence", async () => {
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet("Numbers");
  sheet.addRows([["Date","Description","Amount"],["2026-09-01","Unsafe Excel integer",9007199254740992],["2026-09-02","Exact source string","90071992547409.92"],["2026-09-03","Supported numeric",12.34]]);
  const rows = await parseExcel(await book.xlsx.writeBuffer() as ArrayBuffer,{version: "xlsx-scope-v1",tables: [{sheetId: sheet.id,headerRow: 1,endRow: 4}]});
  const mapping = {accountName: "Synthetic",currencyCode: "EUR",dateColumn: "Date",descriptionColumn: "Description",amountColumn: "Amount",dateFormat: "iso" as const,amountSign: "signed" as const,numericConvention: "decimal-dot" as const};
  const result = inspectRows(rows,mapping);
  expect(result.unresolvedRows).toHaveLength(1); expect(result.unresolvedRows[0].message).toMatch(/unsafe|precision/i);
  expect(result.mapped.map(row => row.amountMinor)).toEqual([9007199254740992n,1234n]);
  expect(result.unresolvedRows[0].sourceRow.__moneo_csv_xlsx_source).toContain('9007199254740992');
  const corrected = inspectRows(rows,{...mapping,rowDecisions: [{rowNumber: 2,action: "correct",values: {Amount: "1.00"}}]});
  expect(corrected.unresolvedRows).toHaveLength(0); expect(corrected.mapped[0].amountMinor).toBe(100n);
  expect(corrected.mapped[0].sourceRow).toEqual(rows[0]);
});

it("inventories hidden/empty sheets, non-first headers and explicit omitted workbook scope", async () => {
  const {bytes,first,second} = await workbookFixture();
  const inspected = await inspectExcel(bytes as ArrayBuffer,{version: "xlsx-scope-v1",tables: [{sheetId: second,headerRow: 1,endRow: 2},{sheetId: first,headerRow: 3,endRow: 4}]});
  expect(inspected.inventory.map(sheet => sheet.name)).toEqual(["Summary","Checking","Savings","Hidden"]);
  expect(inspected.inventory[3].state).toBe("hidden"); expect(inspected.rows![0].Description).toBe("Synthetic checking");
  expect((await inspectExcel(bytes as ArrayBuffer)).rows).toBeNull();
});

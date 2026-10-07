import { expect, it } from "vitest";
import ExcelJS from "exceljs";
import { inspectExcel, inspectRows, mapRows, parseExcel, parseLegacyExcel } from "./csv";

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
  const mapping = {accountName: "Synthetic",currencyCode: "EUR",dateColumn: "Date",descriptionColumn: "Description",amountColumn: "Amount",dateFormat: "iso" as const,amountSign: "signed" as const,numericConvention: "decimal-dot" as const,workbookScope:{version:"xlsx-scope-v1" as const,tables:[{sheetId:sheet.id,headerRow:1,endRow:4}]}};
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

it("keeps date-only native cells distinct from explicitly formatted midnight timestamps",async () => {
  const book=new ExcelJS.Workbook();const sheet=book.addWorksheet("Dates");
  sheet.addRows([["Date","Description","Amount"],[new Date("2026-09-01T00:00:00Z"),"Date only","1.00"],[new Date("2026-09-02T00:00:00Z"),"Explicit midnight","2.00"]]);
  sheet.getRow(2).getCell(1).numFmt="yyyy-mm-dd";sheet.getRow(3).getCell(1).numFmt="yyyy-mm-dd hh:mm:ss";
  const rows=await parseExcel(await book.xlsx.writeBuffer() as ArrayBuffer,{version:"xlsx-scope-v1",tables:[{sheetId:sheet.id,headerRow:1,endRow:3}]});
  expect(rows[0].Date).toBe("2026-09-01");expect(rows[1].Date).toBe("2026-09-02T00:00:00");
  const mapped=mapRows(rows,{accountName:"Synthetic",currencyCode:"EUR",dateColumn:"Date",descriptionColumn:"Description",amountColumn:"Amount",dateFormat:"iso",amountSign:"signed",numericConvention:"decimal-dot",timestampTimezone:"Europe/Berlin",timestampTimezoneConfirmed:true});
  expect(mapped[0].postedAt).toBeUndefined();expect(mapped[1].postedAt).toBe("2026-09-01T22:00:00.000Z");
});

it("replays the frozen legacy first-sheet date-only contract", async () => {
  const book = new ExcelJS.Workbook();
  book.addWorksheet("Original").addRows([["Date","Description","Amount"],[new Date("2026-09-01T14:25:30Z"),"Legacy row","1.00"]]);
  book.addWorksheet("Previously omitted").addRows([["Date","Description","Amount"],["2026-09-02","Omitted row","999.00"]]);
  expect(await parseLegacyExcel(await book.xlsx.writeBuffer() as ArrayBuffer)).toEqual([{Date:"2026-09-01",Description:"Legacy row",Amount:"1.00"}]);
});

it("supports nonoverlapping vertical tables and rejects overlapping or empty selections", async () => {
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet("Tables");
  sheet.addRows([["Date","Description","Amount"],["2026-09-01","First","1.00"],[],["Date","Description","Amount"],["2026-09-02","Second","2.00"]]);
  const empty = book.addWorksheet("Empty"); const bytes = await book.xlsx.writeBuffer() as ArrayBuffer;
  const tables = [{sheetId:sheet.id,headerRow:1,endRow:2},{sheetId:sheet.id,headerRow:4,endRow:5}];
  expect((await parseExcel(bytes,{version:"xlsx-scope-v1",tables})).map(row=>row.Description)).toEqual(["First","Second"]);
  await expect(parseExcel(bytes,{version:"xlsx-scope-v1",tables:[{...tables[0],endRow:4},tables[1]]})).rejects.toThrow(/overlap/);
  await expect(parseExcel(bytes,{version:"xlsx-scope-v1",tables:[{sheetId:empty.id,headerRow:1,endRow:2}]})).rejects.toThrow(/empty/);
});

it("quarantines and preserves nonempty XLSX cells beyond the reviewed headers", async () => {
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet("Extra cells");
  sheet.addRows([["Date","Description","Amount"],["2026-09-01","Valid","1.00"],["2026-09-02","Extra","2.00","Unmapped source"]]);
  const rows = await parseExcel(await book.xlsx.writeBuffer() as ArrayBuffer,{version:"xlsx-scope-v1",tables:[{sheetId:sheet.id,headerRow:1,endRow:3}]});
  const inspected = inspectRows(rows,{accountName:"Synthetic",currencyCode:"EUR",dateColumn:"Date",descriptionColumn:"Description",amountColumn:"Amount",dateFormat:"iso",amountSign:"signed",numericConvention:"decimal-dot"});
  expect(inspected.mapped.map(row=>row.amountMinor)).toEqual([100n]);
  expect(inspected.unresolvedRows).toHaveLength(1);
  expect(inspected.unresolvedRows[0].sourceRow.__moneo_csv_extra_cells).toContain("Unmapped source");
});

it("parses native numeric and cached formula money independently of the reviewed text convention",async()=>{
  const book=new ExcelJS.Workbook();const sheet=book.addWorksheet("Typed money");
  sheet.addRows([["Date","Description","Amount","Balance","Fee"],["2026-09-01","Numeric",123.456,200.123,1.234],["2026-09-02","Text","123,456","200,123","1,234"],["2026-09-03","Formula",{formula:"100+23.456",result:123.456},null,null]]);
  const rows=await parseExcel(await book.xlsx.writeBuffer() as ArrayBuffer,{version:"xlsx-scope-v1",tables:[{sheetId:sheet.id,headerRow:1,endRow:4}]});
  const mapping={accountName:"Synthetic",currencyCode:"KWD",dateColumn:"Date",descriptionColumn:"Description",amountColumn:"Amount",balanceColumn:"Balance",dateFormat:"iso" as const,amountSign:"signed" as const,numericConvention:"decimal-comma" as const,workbookScope:{version:"xlsx-scope-v1" as const,tables:[{sheetId:sheet.id,headerRow:1,endRow:4}]}};
  const result=inspectRows(rows,mapping);expect(result.unresolvedRows).toHaveLength(0);
  expect(result.mapped.map(row=>row.amountMinor)).toEqual([123456n,123456n,123456n]);
  expect(result.mapped[0]).toMatchObject({balanceMinor:200123n,feeMinor:1234n});
  const corrected=inspectRows(rows,{...mapping,rowDecisions:[{rowNumber:2,action:"correct",values:{Amount:"1,234"}}]});
  expect(corrected.mapped[0].amountMinor).toBe(1234n);
});

it("quarantines an inferred numeric Fee using the same safety guard as explicitly mapped money",async()=>{
  const book=new ExcelJS.Workbook();const sheet=book.addWorksheet("Fees");
  sheet.addRows([["Date","Description","Amount","Fee"],["2026-09-01","Unsafe fee","1.00",12345678901234.56]]);
  const rows=await parseExcel(await book.xlsx.writeBuffer() as ArrayBuffer,{version:"xlsx-scope-v1",tables:[{sheetId:sheet.id,headerRow:1,endRow:2}]});
  const result=inspectRows(rows,{accountName:"Synthetic",currencyCode:"EUR",dateColumn:"Date",descriptionColumn:"Description",amountColumn:"Amount",dateFormat:"iso",amountSign:"signed",numericConvention:"decimal-dot",workbookScope:{version:"xlsx-scope-v1",tables:[{sheetId:sheet.id,headerRow:1,endRow:2}]}});
  expect(result.mapped).toHaveLength(0);expect(result.unresolvedRows[0].message).toMatch(/Unsafe XLSX numeric precision in Fee/);
});

it("preserves a legacy auxiliary column with the new provenance name without interpreting it",async()=>{
  const book=new ExcelJS.Workbook();book.addWorksheet("Legacy").addRows([["Date","Description","Amount","__moneo_csv_xlsx_source"],["2026-09-01","Original","1.00","Original note"]]);
  const rows=await parseLegacyExcel(await book.xlsx.writeBuffer() as ArrayBuffer);
  const mapped=mapRows(rows,{accountName:"Synthetic",currencyCode:"EUR",dateColumn:"Date",descriptionColumn:"Description",amountColumn:"Amount",dateFormat:"iso",amountSign:"signed",numericConvention:"decimal-dot"});
  expect(mapped[0].amountMinor).toBe(100n);expect(mapped[0].sourceRow.__moneo_csv_xlsx_source).toBe("Original note");
});

it("keeps legacy auxiliary reserved headers while rejecting them for new scoped imports",async()=>{
  const book=new ExcelJS.Workbook();const sheet=book.addWorksheet("Legacy");sheet.addRows([["Date","Description","Amount","__moneo_csv_notes"],["2026-09-01","Original","1.00","Original note"]]);
  const bytes=await book.xlsx.writeBuffer() as ArrayBuffer;
  expect((await parseLegacyExcel(bytes))[0].__moneo_csv_notes).toBe("Original note");
  await expect(parseExcel(bytes,{version:"xlsx-scope-v1",tables:[{sheetId:sheet.id,headerRow:1,endRow:2}]})).rejects.toThrow(/reserved/);
});

"use client";
import { useState } from "react";
import type { WorkbookScope } from "@/lib/csv";
export type WorkbookSheet = {sheetId: number; name: string; state: string; rowCount: number; columnCount: number; preview: {rowNumber: number; values: string[]}[]};
export function WorkbookScopeReview({inventory, initialScope, busy, onEdit, onPreview}: {inventory: WorkbookSheet[]; initialScope?: WorkbookScope; busy: boolean; onEdit: () => void; onPreview: (scope: WorkbookScope) => void}) {
  const [tables,setTables] = useState<WorkbookScope["tables"]>(initialScope?.tables ?? []);
  function edit(value: WorkbookScope["tables"]) {setTables(value);onEdit();}
  return <section aria-label="Workbook scope" className="space-y-3 rounded border border-border p-4">
    <h3 className="font-semibold">Choose worksheets and tables</h3>
    <p className="text-sm">Only selected table rows will be imported. Review each header and last row. Hidden sheets and summary rows are excluded unless selected. Selected tables must use matching headers.</p>
    {inventory.map(sheet => <article key={sheet.sheetId} className="space-y-2 rounded border border-border p-3 text-sm">
      <label><input type="checkbox" disabled={busy || sheet.rowCount < 2} checked={tables.some(table => table.sheetId === sheet.sheetId)} onChange={event => edit(event.target.checked ? [...tables,{sheetId:sheet.sheetId,headerRow:1,endRow:sheet.rowCount}] : tables.filter(table => table.sheetId !== sheet.sheetId))} /> Include {sheet.name}</label>
      <p>{sheet.rowCount} source rows, {sheet.columnCount} columns, {sheet.state}{sheet.rowCount < 2 ? "; no table data to select" : ""}</p>
      {tables.map((table,index) => table.sheetId === sheet.sheetId && <div key={index} className="flex flex-wrap items-center gap-3">
        <label>Header row for {sheet.name} table {index + 1}<input type="number" min={1} max={sheet.rowCount} value={table.headerRow} disabled={busy} className="ml-2 w-20 rounded border p-1" onChange={event => edit(tables.map((item,i) => i === index ? {...item,headerRow:Number(event.target.value)} : item))} /></label>
        <label>Last row for {sheet.name} table {index + 1}<input type="number" min={table.headerRow + 1} max={sheet.rowCount} value={table.endRow} disabled={busy} className="ml-2 w-20 rounded border p-1" onChange={event => edit(tables.map((item,i) => i === index ? {...item,endRow:Number(event.target.value)} : item))} /></label>
        <button type="button" disabled={busy} onClick={() => edit(tables.filter((_,i) => i !== index))}>Remove table</button>
        <p>Included data rows {table.headerRow + 1} through {table.endRow}; other rows are excluded.</p>
      </div>)}
      {tables.some(table => table.sheetId === sheet.sheetId) && <button type="button" disabled={busy} className="underline" onClick={() => edit([...tables,{sheetId:sheet.sheetId,headerRow:1,endRow:sheet.rowCount}])}>Add another table from {sheet.name}</button>}
      <details><summary>Source preview for {sheet.name} (first 20 rows, first 50 columns)</summary><div className="overflow-x-auto"><table className="text-xs"><tbody>{sheet.preview.map(row => <tr key={row.rowNumber}><th>{row.rowNumber}</th>{row.values.map((value,index) => <td className="border p-1" key={index}>{value}</td>)}</tr>)}</tbody></table></div></details>
    </article>)}
    <p className="text-sm">Excluded worksheets: {inventory.filter(sheet => !tables.some(table => table.sheetId === sheet.sheetId)).map(sheet => sheet.name).join(", ") || "None"}</p>
    <button type="button" className="rounded border border-border px-3 py-2" disabled={busy || !tables.length} onClick={() => onPreview({version:"xlsx-scope-v1",tables})}>Preview selected tables</button>
  </section>;
}

import Papa from "papaparse";
import ExcelJS from "exceljs";
import { transactionInput } from "./validations";

// One shared codebase with exact financial math (stack.md): parse in cents,
// never floats, so CSV/Excel/manual entries agree to the penny.
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

export function parseCsv(text: string) {
  const { data, errors } = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });
  if (errors.length) throw new Error(`CSV parse error: ${errors[0].message}`);
  return data.map((row, i) => {
    const parsed = transactionInput.safeParse({
      date: row.date ?? row.Date,
      description: row.description ?? row.Description,
      amount: Number(row.amount ?? row.Amount),
      category: row.category ?? row.Category ?? undefined,
    });
    if (!parsed.success) throw new Error(`Row ${i + 1}: ${parsed.error.issues[0].message}`);
    return { ...parsed.data, sourceRow: row };
  });
}

export async function parseExcel(file: ArrayBuffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("Workbook has no sheets");
  const header = ws.getRow(1).values as string[];
  const rows: Record<string, string>[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const values = row.values as string[];
    const obj: Record<string, string> = {};
    header.forEach((h, i) => {
      if (h) obj[String(h).toLowerCase()] = String(values[i] ?? "");
    });
    rows.push(obj);
  });
  return rows.map((row, i) => {
    const parsed = transactionInput.safeParse({
      date: row.date,
      description: row.description,
      amount: Number(row.amount),
      category: row.category || undefined,
    });
    if (!parsed.success) throw new Error(`Row ${i + 1}: ${parsed.error.issues[0].message}`);
    return { ...parsed.data, sourceRow: row };
  });
}

import Papa from "papaparse";
import ExcelJS from "exceljs";
import { z } from "zod";

export type SourceRow = Record<string, string>;

export const mappingSchema = z.object({
  accountName: z.string().trim().min(1),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  dateColumn: z.string().min(1),
  descriptionColumn: z.string().min(1),
  amountColumn: z.string().min(1).optional(),
  debitColumn: z.string().min(1).optional(),
  creditColumn: z.string().min(1).optional(),
  currencyColumn: z.string().min(1).optional(),
  balanceColumn: z.string().min(1).optional(),
  merchantColumn: z.string().min(1).optional(),
  categoryColumn: z.string().min(1).optional(),
  externalIdColumn: z.string().min(1).optional(),
  dateFormat: z.enum(["iso", "dmy", "mdy"]),
  amountSign: z.enum(["signed", "outflow-positive"]),
}).strict().refine(
  (m) => m.amountColumn ? !m.debitColumn && !m.creditColumn : Boolean(m.debitColumn && m.creditColumn),
  "Choose either one amount column or both debit and credit columns",
);

export type ImportMapping = z.infer<typeof mappingSchema>;

export function parseCsv(text: string): SourceRow[] {
  const result = Papa.parse<SourceRow>(text.replace(/^\uFEFF/, ""), {
    header: true,
    skipEmptyLines: "greedy",
  });
  if (result.errors.length) throw new Error(`CSV parse error: ${result.errors[0].message}`);
  if (new Set(result.meta.fields).size !== result.meta.fields?.length) throw new Error("Duplicate CSV headers");
  return result.data;
}

function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object" && "result" in value) return String(value.result ?? "");
  if (typeof value === "object") return cell.text;
  return String(value);
}

export async function parseExcel(file: ArrayBuffer): Promise<SourceRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("Workbook has no sheets");
  const headers = Array.from({ length: sheet.columnCount }, (_, i) => cellText(sheet.getRow(1).getCell(i + 1)).trim());
  if (headers.some((h) => !h) || new Set(headers).size !== headers.length) throw new Error("Missing or duplicate XLSX headers");
  const rows: SourceRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1 || !row.hasValues) return;
    rows.push(Object.fromEntries(headers.map((header, i) => [header, cellText(row.getCell(i + 1))])));
  });
  return rows;
}

export function validateMapping(input: unknown, rows: SourceRow[]): ImportMapping {
  const mapping = mappingSchema.parse(input);
  if (!rows.length) throw new Error("File has no data rows");
  const headers = Object.keys(rows[0]);
  for (const column of [mapping.dateColumn, mapping.descriptionColumn, mapping.amountColumn,
    mapping.debitColumn, mapping.creditColumn, mapping.currencyColumn, mapping.balanceColumn,
    mapping.merchantColumn, mapping.categoryColumn, mapping.externalIdColumn]) {
    if (column && !headers.includes(column)) throw new Error(`Unknown column: ${column}`);
  }
  return mapping;
}

export function parseAmountMinor(input: string): bigint {
  let value = input.trim().replace(/\s/g, "").replace(/[€$£]/g, "");
  if (!/^(?:\(\d[\d.,]*\)|[-+]?\d[\d.,]*|\d[\d.,]*-)$/.test(value)) throw new Error(`Invalid amount: ${input}`);
  const negative = /^\(.*\)$/.test(value) || value.startsWith("-") || value.endsWith("-");
  value = value.replace(/[()\-+]/g, "");
  const comma = value.lastIndexOf(",");
  const dot = value.lastIndexOf(".");
  if (/^\d{1,3}([.,]\d{3})+$/.test(value)) return BigInt(value.replace(/[.,]/g, "")) * (negative ? -100n : 100n);
  const decimal = comma > dot ? "," : ".";
  const parts = value.split(decimal);
  if (parts.length > 2 || !/^(\d{1,3}([.,]\d{3})*|\d+)$/.test(parts[0]) ||
      (parts[1] !== undefined && !/^\d{1,2}$/.test(parts[1]))) {
    throw new Error(`Invalid amount: ${input}`);
  }
  const whole = parts[0].replace(/[.,]/g, "");
  const minor = BigInt(whole) * 100n + BigInt((parts[1] ?? "").padEnd(2, "0") || "0");
  return negative ? -minor : minor;
}

function parseDate(input: string, format: ImportMapping["dateFormat"]): string {
  const value = input.trim();
  const match = format === "iso"
    ? /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value)
    : /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(value);
  if (!match) throw new Error(`Invalid date: ${input}`);
  const [year, month, day] = format === "iso"
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : [Number(match[3]), Number(match[format === "dmy" ? 2 : 1]), Number(match[format === "dmy" ? 1 : 2])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day)
    throw new Error(`Invalid date: ${input}`);
  return date.toISOString().slice(0, 10);
}

export type MappedRow = {
  rowNumber: number;
  postedOn: string;
  description: string;
  amountMinor: bigint;
  currencyCode: string;
  sourceRow: SourceRow;
  merchant?: string;
  category?: string;
  externalId?: string;
  balanceMinor?: bigint;
};

// Tiny explicit high-confidence merchant canonicalization. Only these
// substrings may produce a merchant name when no merchant column exists.
// Anything else stays unknown (null) — no speculative AI guessing.
export const MERCHANT_CANONICALS: Record<string, string> = {
  amazon: "Amazon",
  amzn: "Amazon",
  spotify: "Spotify",
  netflix: "Netflix",
  uber: "Uber",
  ikea: "IKEA",
};

function canonicalizeFragment(lower: string): string | null {
  for (const [fragment, canonical] of Object.entries(MERCHANT_CANONICALS)) {
    if (lower.includes(fragment)) return canonical;
  }
  return null;
}

export function normalizeMerchantDisplay(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 100);
}

// Resolve the canonical merchant display name for one row.
// Explicit merchant columns win (normalized, canonicalized when known).
// Without one, only a tiny explicit fragment table may infer a name;
// otherwise returns null (unknown merchant, import continues).
export function resolveMerchantName(explicit: string | undefined, description: string): string | null {
  const cleaned = explicit?.trim().replace(/\s+/g, " ");
  if (cleaned) {
    const display = cleaned.slice(0, 100);
    const lower = display.toLowerCase();
    if (MERCHANT_CANONICALS[lower]) return MERCHANT_CANONICALS[lower];
    return canonicalizeFragment(lower) ?? display;
  }
  return canonicalizeFragment(description.toLowerCase());
}

// Explicit source categories only. Empty or overlong values become null
// (uncategorized) so they never block an otherwise valid import.
export function normalizeCategoryName(input: string | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 100) return null;
  return trimmed;
}

export function mapRows(rows: SourceRow[], input: unknown): MappedRow[] {
  const mapping = validateMapping(input, rows);
  return rows.map((sourceRow, index) => {
    try {
      const description = sourceRow[mapping.descriptionColumn]?.trim();
      if (!description) throw new Error("Missing description");
      const currencyCode = (mapping.currencyColumn ? sourceRow[mapping.currencyColumn] : mapping.currencyCode).trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currencyCode)) throw new Error("Invalid currency");
      let amountMinor: bigint;
      if (mapping.amountColumn) {
        amountMinor = parseAmountMinor(sourceRow[mapping.amountColumn] ?? "");
        if (mapping.amountSign === "outflow-positive") amountMinor = -amountMinor;
      } else {
        const debit = sourceRow[mapping.debitColumn!] ?? "";
        const credit = sourceRow[mapping.creditColumn!] ?? "";
        if (Boolean(debit.trim()) === Boolean(credit.trim())) throw new Error("Expected exactly one debit or credit value");
        amountMinor = credit.trim() ? parseAmountMinor(credit) : -parseAmountMinor(debit);
        if ((credit.trim() && amountMinor < 0n) || (debit.trim() && amountMinor > 0n))
          throw new Error("Debit and credit values must be positive");
        if (amountMinor === 0n) throw new Error("Zero debit or credit");
      }
      return {
        rowNumber: index + 2,
        postedOn: parseDate(sourceRow[mapping.dateColumn] ?? "", mapping.dateFormat),
        description,
        amountMinor,
        currencyCode,
        sourceRow,
        ...(mapping.merchantColumn && sourceRow[mapping.merchantColumn]?.trim() ? { merchant: sourceRow[mapping.merchantColumn].trim() } : {}),
        ...(mapping.categoryColumn && sourceRow[mapping.categoryColumn]?.trim() ? { category: sourceRow[mapping.categoryColumn].trim() } : {}),
        ...(mapping.externalIdColumn && sourceRow[mapping.externalIdColumn]?.trim() ? { externalId: sourceRow[mapping.externalIdColumn].trim() } : {}),
        ...(mapping.balanceColumn && sourceRow[mapping.balanceColumn]?.trim() ? { balanceMinor: parseAmountMinor(sourceRow[mapping.balanceColumn]) } : {}),
      };
    } catch (error) {
      throw new Error(`Row ${index + 2}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

export function previewImport(rows: SourceRow[], input: unknown) {
  const mapping = validateMapping(input, rows);
  const mapped = mapRows(rows, mapping);
  const dates = mapped.map((row) => row.postedOn).sort();
  return {
    accountName: mapping.accountName,
    currencyCode: mapping.currencyCode,
    totalRows: mapped.length,
    dateRange: { from: dates[0], to: dates[dates.length - 1] },
    examples: mapped.slice(0, 5),
  };
}

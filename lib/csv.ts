import Papa from "papaparse";
import ExcelJS from "exceljs";
import { z } from "zod";
import { minorDigits } from "@/lib/finance/fx";
import { calendarDate, reviewedLocalTimestamp } from "@/lib/finance/calendar";

const timezoneSchema = z.string().max(100).refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}, "Invalid timestamp timezone");

export type SourceRow = Record<string, string>;
const csvIssueColumn = "__moneo_csv_issue";
const csvExtraColumn = "__moneo_csv_extra_cells";

function assertStorageCompatible(value: unknown): void {
  if (typeof value === "string" && value.includes("\0")) throw new Error("Source or reviewed mapping contains NUL characters that PostgreSQL cannot preserve");
  if (typeof value === "string") for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) throw new Error("Source or reviewed mapping contains an unpaired Unicode surrogate; use valid Unicode text before continuing");
  }
  if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
    assertStorageCompatible(key);
    assertStorageCompatible(item);
  }
}

export const workbookScopeSchema = z.object({
  version: z.literal("xlsx-scope-v1"),
  tables: z.array(z.object({ sheetId: z.number().int().positive(), headerRow: z.number().int().positive(), endRow: z.number().int().positive() }).strict()
    .refine(table => table.endRow > table.headerRow, "A table needs data rows after its header")).min(1).max(100),
}).strict();
export type WorkbookScope = z.infer<typeof workbookScopeSchema>;


export const mappingSchema = z.object({
  accountName: z.string().trim().min(1).refine(value => Array.from(value).length <= 100, "Account name exceeds 100 characters"),
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
  statusColumn: z.string().min(1).optional(),
  typeColumn: z.string().min(1).optional(),
  feeColumn: z.string().min(1).optional(),
  timestampTimezone: timezoneSchema.optional(),
  timestampTimezoneConfirmed: z.boolean().optional(),
  calendarTimezone: timezoneSchema.optional(),
  accountColumn: z.string().min(1).optional(),
  productColumn: z.string().min(1).optional(),
  accountRoutes: z.array(z.object({
    accountValue: z.string().optional(),
    productValue: z.string().optional(),
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
    accountName: z.string().trim().min(1).max(100),
  }).strict()).max(1000).optional(),
  dateFormat: z.enum(["iso", "dmy", "mdy"]),
  amountSign: z.enum(["signed", "outflow-positive"]),
  numericConvention: z.enum(["decimal-dot", "decimal-comma"]).optional(),
  parserVersion: z.literal("numeric-convention-v2").optional(),
  rowContractVersion: z.literal("normalized-row-v1").optional(),
  workbookScope: workbookScopeSchema.optional(),
  rowDecisions: z.array(z.discriminatedUnion("action", [
    z.object({ rowNumber: z.number().int().min(2), action: z.literal("correct"),
      values: z.record(z.string(), z.string().max(100_000)).refine(value => Object.keys(value).length > 0, "Correction needs source values") }).strict(),
    z.object({ rowNumber: z.number().int().min(2), action: z.literal("exclude"), reason: z.string().trim().min(1).max(500) }).strict(),
  ])).max(100_000).optional(),
}).strict().refine(
  (m) => m.amountColumn ? !m.debitColumn && !m.creditColumn : Boolean(m.debitColumn && m.creditColumn),
  "Choose either one amount column or both debit and credit columns",
);

export type ImportMapping = z.infer<typeof mappingSchema>;

// Recognized statement formats avoid a provider round trip; every proposal still needs review.
export function proposeKnownStatementMapping(rows: SourceRow[], accountName: string, currencyCode: string): ImportMapping | undefined {
  const headers = Object.keys(rows[0] ?? {});
  const has = (columns: string[]) => columns.every(column => headers.includes(column));
  const base = { accountName, currencyCode, amountColumn: "Amount", currencyColumn: "Currency", amountSign: "signed" as const };
  if (has(["Type", "Product", "Started Date", "Completed Date", "Description", "Amount", "Fee", "Currency", "State", "Balance"]))
    return proposeAccountRoutes(rows, { ...base, dateColumn: "Completed Date", descriptionColumn: "Description", dateFormat: "iso",
      productColumn: "Product", statusColumn: "State", balanceColumn: "Balance", typeColumn: "Type", feeColumn: "Fee" });
  if (has(["Booking date", "Value date", "Transaction type", "Booking text", "Amount", "Currency", "Account IBAN", "Category", "Sender", "Recipient", "Transfer purpose"]))
    return proposeAccountRoutes(rows, { ...base, dateColumn: "Booking date", descriptionColumn: "Booking text", dateFormat: "dmy",
      categoryColumn: "Category", typeColumn: "Transaction type", accountColumn: "Account IBAN" });
  return undefined;
}

export function validateImportConfirmation(rows: SourceRow[], input: unknown): ImportMapping {
  const mapping = validateMapping(input, rows);
  if (!mapping.numericConvention) throw new Error("Review and select the source numeric convention before importing");
  const naive = reviewedSourceRows(rows, mapping).some(row => row && /[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(row[mapping.dateColumn]?.trim() ?? ""));
  if (naive && (!mapping.timestampTimezone || !mapping.timestampTimezoneConfirmed))
    throw new Error("Review and confirm the source timestamp timezone before importing");
  mapRows(rows, mapping);
  return { ...mapping, parserVersion: "numeric-convention-v2", rowContractVersion: "normalized-row-v1" };
}

export function proposeStatementTimezones(rows: SourceRow[], mapping: ImportMapping, workspaceTimezone = "Europe/Berlin"): ImportMapping {
  const naive = rows.some(row => /[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(row[mapping.dateColumn]?.trim() ?? ""));
  return { ...mapping, calendarTimezone: workspaceTimezone,
    ...(naive ? { timestampTimezone: mapping.timestampTimezone ?? workspaceTimezone,
      timestampTimezoneConfirmed: mapping.timestampTimezoneConfirmed ?? false } : {}) };
}

export function parseCsv(text: string): SourceRow[] {
  assertStorageCompatible(text);
  const result = Papa.parse<SourceRow>(text.replace(/^\uFEFF/, ""), {
    header: true,
    skipEmptyLines: "greedy",
  });
  if (Object.keys(result.meta.renamedHeaders ?? {}).length || new Set(result.meta.fields).size !== result.meta.fields?.length)
    throw new Error("Duplicate CSV headers");
  const headers = result.meta.fields ?? [];
  if (headers.some(header => header.startsWith("__moneo_csv_") || header === "__parsed_extra")) throw new Error("Reserved CSV evidence header");
  const fatal = result.errors.find(error => error.type !== "FieldMismatch" || !["TooFewFields", "TooManyFields"].includes(error.code)
    || !Number.isInteger(error.row) || error.row! < 0 || error.row! >= result.data.length);
  if (fatal) throw new Error(`CSV parse error: ${fatal.message}`);
  const issues = new Map(result.errors.map(error => [error.row!, error.code]));
  return result.data.map((row, index) => {
    const extra = (row as unknown as { __parsed_extra?: string[] }).__parsed_extra;
    return { ...Object.fromEntries(headers.map(header => [header, row[header] ?? ""])),
      ...(issues.has(index) ? { [csvIssueColumn]: issues.get(index)!,
        __moneo_csv_field_count: String(headers.filter(header => Object.hasOwn(row, header)).length + (extra?.length ?? 0)) } : {}),
      ...(extra?.length ? { [csvExtraColumn]: JSON.stringify(extra) } : {}) };
  });
}

function cellText(cell: ExcelJS.Cell, preserveTime = false): string {
  const raw = cell.value;
  const value = raw && typeof raw === "object" && "result" in raw ? raw.result : raw;
  if (value == null) return "";
  if (value instanceof Date) {
    const iso = value.toISOString();
    const format = (cell.numFmt ?? "").replace(/"[^"]*"|\\.|\[[^\]]*\]/g, "");
    const hasTime = /h|s|AM\/PM/i.test(format) || value.getUTCHours() !== 0 || value.getUTCMinutes() !== 0 || value.getUTCSeconds() !== 0 || value.getUTCMilliseconds() !== 0;
    return preserveTime && hasTime ? iso.replace(/Z$/, "").replace(/\.000$/, "") : iso.slice(0, 10);
  }
  if (typeof value === "object" && "result" in value) return String(value.result ?? "");
  if (typeof value === "object") return cell.text;
  return String(value);
}


function workbookRows(workbook: ExcelJS.Workbook, input?: WorkbookScope, legacy = false): SourceRow[] {
  if (!workbook.worksheets.length) throw new Error("Workbook has no sheets");
  if (!input && !legacy && workbook.worksheets.length !== 1) throw new Error("Select the included worksheets and table scope before importing");
  const scope = input ? workbookScopeSchema.parse(input) : { version: "xlsx-scope-v1", tables: [{ sheetId: workbook.worksheets[0].id, headerRow: 1, endRow: workbook.worksheets[0].rowCount }] };
  const selected = scope.tables.map(table => {
    const sheet = workbook.getWorksheet(table.sheetId);
    if (!sheet || table.endRow > sheet.rowCount || !sheet.rowCount) throw new Error("Selected worksheet table is unavailable or empty");
    return { ...table, sheet, sheetIndex: workbook.worksheets.indexOf(sheet) };
  }).sort((a, b) => a.sheetIndex - b.sheetIndex || a.headerRow - b.headerRow);
  const rows: SourceRow[] = [];
  let previous: typeof selected[number] | undefined;
  let sharedHeaders: string[] | undefined;
  for (const table of selected) {
    if (previous?.sheet.id === table.sheet.id && table.headerRow <= previous.endRow) throw new Error("Selected workbook tables overlap");
    previous = table;
    const header = table.sheet.getRow(table.headerRow);
    const headers = Array.from({length: legacy ? table.sheet.columnCount : header.cellCount}, (_, index) => cellText(header.getCell(index + 1)).trim());
    if (!headers.length || headers.some(value => !value || (!legacy && value.startsWith("__moneo_csv_"))) || new Set(headers).size !== headers.length) throw new Error("Missing, duplicate or reserved XLSX headers");
    if (sharedHeaders && JSON.stringify(headers) !== JSON.stringify(sharedHeaders)) throw new Error("Select tables with matching headers; inspect differently structured tables separately");
    sharedHeaders = headers;
    for (let rowNumber = table.headerRow + 1; rowNumber <= table.endRow; rowNumber++) {
      const row = table.sheet.getRow(rowNumber);
      if (!row.hasValues) continue;
      const values: SourceRow = Object.fromEntries(headers.map((name, index) => {
        return [name, cellText(row.getCell(index + 1), !!input)];
      }));
      if (input && row.cellCount > headers.length) {
        const extra = Array.from({length: row.cellCount - headers.length}, (_, index) => {
          const cell = row.getCell(headers.length + index + 1);
          return {columnNumber: headers.length + index + 1, type: cell.type, value: cell.value, numberFormat: cell.numFmt};
        });
        if (extra.some(cell => cell.value !== null && cell.value !== "")) {
          values[csvIssueColumn] = "TooManyFields";
          values[csvExtraColumn] = JSON.stringify(extra);
        }
      }
      if (input) values.__moneo_csv_xlsx_source = JSON.stringify({ version: "xlsx-scope-v1", sheetId: table.sheet.id, sheetName: table.sheet.name, sheetState: table.sheet.state, headerRow: table.headerRow, rowNumber,
        cells: Object.fromEntries(headers.map((name, index) => { const cell = row.getCell(index + 1); return [name, { type: cell.type, value: cell.value, numberFormat: cell.numFmt }]; })) });
      rows.push(values);
    }
  }
  assertStorageCompatible(rows);
  return rows;
}

export async function inspectExcel(file: ArrayBuffer, scope?: WorkbookScope) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file);
  const inventory = workbook.worksheets.map(sheet => ({ sheetId: sheet.id, name: sheet.name, state: sheet.state, rowCount: sheet.rowCount, columnCount: sheet.columnCount,
    preview: Array.from({length: Math.min(sheet.rowCount, 20)}, (_, index) => ({rowNumber: index + 1, values: Array.from({length: Math.min(sheet.columnCount, 50)}, (_, column) => cellText(sheet.getRow(index + 1).getCell(column + 1), true)) })) }));
  return { inventory, rows: scope ? workbookRows(workbook, scope) : null };
}

// Replay only an already confirmed pre-scope import using its original contract.
// New confirmation always requires explicit scope and cannot request this mode.
export async function parseLegacyExcel(file: ArrayBuffer): Promise<SourceRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file);
  return workbookRows(workbook, undefined, true);
}

export async function parseExcel(file: ArrayBuffer, scope?: WorkbookScope): Promise<SourceRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file);
  return workbookRows(workbook, scope);
}

export function validateMapping(input: unknown, rows: SourceRow[]): ImportMapping {
  const mapping = mappingSchema.parse(input);
  // Exclusions and corrections never rewrite incompatible original evidence.
  assertStorageCompatible(rows);
  assertStorageCompatible(mapping);
  if (!rows.length) throw new Error("File has no data rows");
  const headers = Object.keys(rows[0]).filter(header => !header.startsWith("__moneo_csv_"));
  const decisions = new Set<number>();
  for (const decision of mapping.rowDecisions ?? []) {
    if (decision.rowNumber > rows.length + 1 || decisions.has(decision.rowNumber)) throw new Error("Invalid or duplicate source row decision");
    decisions.add(decision.rowNumber);
    if (decision.action === "correct" && Object.keys(decision.values).some(key => !Object.hasOwn(rows[decision.rowNumber - 2], key)))
      throw new Error("Correction contains an unknown source column");
  }
  for (const column of [mapping.dateColumn, mapping.descriptionColumn, mapping.amountColumn,
    mapping.debitColumn, mapping.creditColumn, mapping.currencyColumn, mapping.balanceColumn,
    mapping.merchantColumn, mapping.categoryColumn, mapping.externalIdColumn, mapping.statusColumn,
    mapping.accountColumn, mapping.productColumn, mapping.typeColumn, mapping.feeColumn]) {
    if (column && !headers.includes(column)) throw new Error(`Unknown column: ${column}`);
  }
  for (const [name, column] of [["product", mapping.productColumn], ["account", mapping.accountColumn]]) {
    const detected = headers.find(header => header.trim().toLowerCase() === name);
    if (detected && !column) throw new Error(`Review account routing: map ${detected}`);
  }
  const detectedStatus = headers.find(header => /^(status|state)$/i.test(header.trim()));
  if (detectedStatus && !mapping.statusColumn) throw new Error(`Review source status: map ${detectedStatus}`);
  return mapping;
}

export function validateAiMapping(input: unknown, rows: SourceRow[], workspaceCurrency: string): ImportMapping {
  // Only the user chooses the source convention; provenance is stamped by confirmation.
  const mapping = { ...mappingSchema.parse(input), numericConvention: undefined, parserVersion: undefined, rowContractVersion: undefined, rowDecisions: undefined };
  return validateMapping(proposeAccountRoutes(rows, mapping.currencyColumn ? mapping : { ...mapping, currencyCode: workspaceCurrency }), rows);
}

// Suggestions are displayed in the preview; confirmation validates the exact reviewed routes.
export function proposeAccountRoutes(rows: SourceRow[], input: unknown): ImportMapping {
  const mapping = mappingSchema.parse(input);
  const headers = Object.keys(rows[0] ?? {});
  const accountColumn = mapping.accountColumn ?? headers.find(header => header.trim().toLowerCase() === "account");
  const productColumn = mapping.productColumn ?? headers.find(header => header.trim().toLowerCase() === "product");
  const statusColumn = mapping.statusColumn ?? headers.find(header => /^(status|state)$/i.test(header.trim()));
  if (mapping.accountRoutes || (!accountColumn && !productColumn)) return { ...mapping, accountColumn, productColumn, statusColumn };
  const routes = new Map<string, NonNullable<ImportMapping["accountRoutes"]>[number]>();
  for (const row of rows) {
    const accountValue = accountColumn ? row[accountColumn]?.trim() : undefined;
    const productValue = productColumn ? row[productColumn]?.trim() : undefined;
    const currencyCode = (mapping.currencyColumn ? row[mapping.currencyColumn] : mapping.currencyCode)?.trim().toUpperCase();
    // Invalid source currencies remain quarantined observations, rather than
    // poisoning the route proposal for valid neighboring rows.
    if (!/^[A-Z]{3}$/.test(currencyCode ?? "")) continue;
    const key = JSON.stringify([accountValue, productValue, currencyCode]);
    routes.set(key, { accountValue, productValue, currencyCode,
      accountName: [mapping.accountName, accountValue, productValue].filter(Boolean).join(" · ") });
  }
  return mappingSchema.parse({ ...mapping, accountColumn, productColumn, statusColumn, accountRoutes: [...routes.values()] });
}

function databaseMinor(amount: bigint): bigint {
  if (amount > 9223372036854775807n || amount < -9223372036854775808n)
    throw new Error("Amount exceeds database range");
  return amount;
}

export function parseAmountMinor(input: string, currencyCode: string = "EUR", convention?: ImportMapping["numericConvention"]): bigint {
  const digits = minorDigits(currencyCode);
  let value = input.trim().replace(/\s/g, "").replace(/[€$£]/g, "");
  if (!/^(?:\(\d[\d.,]*\)|[-+]?\d[\d.,]*|\d[\d.,]*-)$/.test(value)) throw new Error(`Invalid amount: ${input}`);
  const negative = /^\(.*\)$/.test(value) || value.startsWith("-") || value.endsWith("-");
  value = value.replace(/[()\-+]/g, "");
  const comma = value.lastIndexOf(",");
  const dot = value.lastIndexOf(".");
  if (!convention && (comma < 0 || dot < 0) && /^\d{1,3}([.,]\d{3})+$/.test(value))
    throw new Error("Review the source numeric convention: separator could represent decimals or grouping");
  const decimal = convention ? (convention === "decimal-dot" ? "." : ",") : comma > dot ? "," : ".";
  const grouping = decimal === "." ? "," : ".";
  const parts = value.split(decimal);
  const wholePattern = grouping === "," ? /^(\d{1,3}(,\d{3})+|\d+)$/ : /^(\d{1,3}(\.\d{3})+|\d+)$/;
  if (parts.length > 2 || !wholePattern.test(parts[0]) ||
      (parts[1] !== undefined && (!/^\d+$/.test(parts[1]) || parts[1].length > digits))) {
    throw new Error(`Invalid amount: ${input}`);
  }
  const whole = parts[0].replace(/[.,]/g, "");
  const fraction = (parts[1] ?? "").padEnd(digits, "0").slice(0, digits);
  const minor = BigInt(whole) * pow10(digits) + BigInt(fraction || "0");
  return databaseMinor(negative ? -minor : minor);
}

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function parseDate(input: string, format: ImportMapping["dateFormat"]): string {
  const value = input.trim();
  const match = format === "iso"
    ? /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:[0-5]\d)?)?$/.exec(value)
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

function parseTimestamp(value: string, timeZone?: string): string | undefined {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/.exec(value.trim());
  if (!match) return undefined;
  if (match[7]) {
    const instant = new Date(value.trim().replace(" ", "T"));
    if (!Number.isFinite(instant.getTime())) throw new Error("Invalid timestamp offset");
    return instant.toISOString();
  }
  // Legacy mappings keep their original posting date; new confirmations require the timezone.
  if (!timeZone) return undefined;
  return reviewedLocalTimestamp(value, timeZone);
}

export type MappedRow = {
  accountName: string;
  rowNumber: number;
  postedOn: string;
  postedAt?: string;
  calendarTimezone?: string;
  description: string;
  amountMinor: bigint;
  currencyCode: string;
  status: "posted" | "pending";
  kind: "ordinary" | "refund";
  reviewReasons: string[];
  sourceType?: string;
  feeMinor?: bigint;
  feeEvidence?: { treatment: "included" | "additional" | "unknown"; deltaMinor?: bigint; previousRowNumber?: number };
  sourceRow: SourceRow;
  merchant?: string;
  category?: string;
  externalId?: string;
  balanceMinor?: bigint;
};

// Explicit posted/pending/completed indicator only. Empty means posted. Anything else
// throws so a mis-mapped column never silently flips pending/posted.
export function parseTransactionStatus(input: string | undefined): "posted" | "pending" {
  if (input === undefined) return "posted";
  const value = input.trim().toLowerCase();
  if (!value) return "posted";
  if (value === "pending") return "pending";
  if (value === "posted" || value === "completed") return "posted";
  throw new Error(`Invalid status: ${input}`);
}

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
    if (new RegExp(`\\b${fragment}\\b`).test(lower)) return canonical;
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
  const result = inspectRows(rows, input);
  if (result.unresolvedRows.length) throw new Error(result.unresolvedRows[0].message);
  return result.mapped;
}

export function mapImportReviewRow(sourceRow: SourceRow, rowNumber: number, input: unknown): MappedRow {
  if (!Number.isInteger(rowNumber) || rowNumber < 2) throw new Error("Invalid original source row index");
  const mapping = mappingSchema.parse(input);
  const decision = mapping.rowDecisions?.find(item => item.rowNumber === rowNumber);
  if (decision?.action === "exclude") throw new Error("Excluded source observation cannot be accepted");
  const row = mapRows([sourceRow], { ...mapping, rowDecisions: decision ? [{ ...decision, rowNumber: 2 }] : undefined })[0];
  return { ...row, rowNumber };
}

function reviewedSourceRows(rows: SourceRow[], mapping: ImportMapping): (SourceRow | null)[] {
  const decisions = new Map((mapping.rowDecisions ?? []).map(decision => [decision.rowNumber, decision]));
  return rows.map((row, index) => {
    const decision = decisions.get(index + 2);
    return decision?.action === "exclude" ? null : decision?.action === "correct" ? { ...row, ...decision.values } : row;
  });
}

export function inspectRows(rows: SourceRow[], input: unknown) {
  const mapping = validateMapping(input, rows);
  const decisions = new Map((mapping.rowDecisions ?? []).map(decision => [decision.rowNumber, decision]));
  const excludedRows: { rowNumber: number; sourceRow: SourceRow; reason: string }[] = [];
  const unresolvedRows: { rowNumber: number; sourceRow: SourceRow; reason: "invalid_row"; message: string }[] = [];
  const mapped: MappedRow[] = reviewedSourceRows(rows, mapping).flatMap((sourceRow, index): MappedRow[] => {
    if (!sourceRow) {
      const decision = decisions.get(index + 2)!;
      if (decision.action === "exclude") excludedRows.push({ rowNumber: index + 2, sourceRow: rows[index], reason: decision.reason });
      return [];
    }
    try {
      const header = (name: string) => Object.keys(sourceRow).find(key => key.trim().toLowerCase() === name);
      const typeColumn = mapping.typeColumn ?? header("type");
      const feeColumn = mapping.feeColumn ?? header("fee");
      const decision = decisions.get(index + 2);
      const evidence = rows[index].__moneo_csv_xlsx_source ? JSON.parse(rows[index].__moneo_csv_xlsx_source) as {cells: Record<string,{value: unknown}>} : undefined;
      const numericCell = (column: string) => {
        if (decision?.action === "correct" && Object.hasOwn(decision.values, column)) return undefined;
        const original = evidence?.cells[column]?.value;
        const value = original && typeof original === "object" && "result" in original ? original.result : original;
        return typeof value === "number" ? value : undefined;
      };
      if (rows[index][csvIssueColumn]) {
        const decision = decisions.get(index + 2);
        if (decision?.action !== "correct") throw new Error(`Source field mismatch (${rows[index][csvIssueColumn]}): explicitly review mapped cells or exclude this observation`);
        const columns = Object.entries(mapping).filter(([key, value]) => key.endsWith("Column") && typeof value === "string").map(([, value]) => value as string);
        for (const name of ["type", "fee"]) {
          const column = Object.keys(rows[index]).find(key => key.trim().toLowerCase() === name);
          if (column) columns.push(column);
        }
        if (columns.some(column => !Object.hasOwn(decision.values, column))) throw new Error("Source field mismatch: review all mapped cells before accepting the corrected interpretation");
      }
      if (evidence) {
        for (const column of [mapping.amountColumn, mapping.debitColumn, mapping.creditColumn, mapping.balanceColumn, feeColumn].filter((name): name is string => Boolean(name))) {
          const value = numericCell(column);
          if (value === undefined) continue;
          const significantDigits = String(value).split(/e/i)[0].replace(/[-.]/g, "").replace(/^0+/, "").length;
          if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER || significantDigits > 15)
            throw new Error(`Unsafe XLSX numeric precision in ${column}: review an exact source string or explicitly correct/exclude the observation`);
        }
      }
      const description = sourceRow[mapping.descriptionColumn]?.trim();
      if (!description) throw new Error("Missing description");
      // PostgreSQL length counts Unicode code points, rather than UTF-16 units.
      if (Array.from(description).length > 500) throw new Error("Description exceeds 500 characters");
      // The RPC has an 11 MB JSON record boundary. Account for escaped original
      // evidence, JSONB separator spaces and duplicated external IDs, reserving
      // 1 MB for bounded fields.
      if (new TextEncoder().encode(JSON.stringify({ originalRow: rows[index],
        externalId: mapping.externalIdColumn ? sourceRow[mapping.externalIdColumn] : null })).byteLength + 2 * Object.keys(rows[index]).length > 10_000_000)
        throw new Error("Source evidence exceeds the import record limit; review an explicit exclusion");
      const currencyCode = (mapping.currencyColumn ? sourceRow[mapping.currencyColumn] : mapping.currencyCode).trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currencyCode)) throw new Error("Invalid currency");
      const accountValue = mapping.accountColumn ? sourceRow[mapping.accountColumn]?.trim() : undefined;
      const productValue = mapping.productColumn ? sourceRow[mapping.productColumn]?.trim() : undefined;
      const routes = mapping.accountRoutes?.filter(route => route.currencyCode === currencyCode &&
        route.accountValue === accountValue && route.productValue === productValue);
      if ((mapping.accountColumn || mapping.productColumn || mapping.accountRoutes) && routes?.length !== 1)
        throw new Error("Review account routing: each account/product/currency requires exactly one route");
      const accountName = routes?.[0]?.accountName ?? mapping.accountName;
      const money = (column: string) => parseAmountMinor(sourceRow[column] ?? "", currencyCode, numericCell(column) === undefined ? mapping.numericConvention : "decimal-dot");
      let amountMinor: bigint;
      if (mapping.amountColumn) {
        amountMinor = money(mapping.amountColumn);
        if (mapping.amountSign === "outflow-positive") amountMinor = -amountMinor;
      } else {
        const debit = sourceRow[mapping.debitColumn!] ?? "";
        const credit = sourceRow[mapping.creditColumn!] ?? "";
        if (Boolean(debit.trim()) === Boolean(credit.trim())) throw new Error("Expected exactly one debit or credit value");
        amountMinor = credit.trim() ? money(mapping.creditColumn!) : -money(mapping.debitColumn!);
        if ((credit.trim() && amountMinor < 0n) || (debit.trim() && amountMinor > 0n))
          throw new Error("Debit and credit values must be positive");
        if (amountMinor === 0n) throw new Error("Zero debit or credit");
      }
      databaseMinor(amountMinor);
      const sourceType = typeColumn ? sourceRow[typeColumn]?.trim() : undefined;
      const type = sourceType?.toLowerCase();
      const reviewReasons: string[] = [];
      let kind: MappedRow["kind"] = "ordinary";
      if (type === "transfer" || type === "transfer (realtime)") reviewReasons.push("source_transfer");
      else if (type === "exchange") reviewReasons.push("source_exchange");
      else if (type === "card refund") {
        if (amountMinor > 0n) kind = "refund";
        else reviewReasons.push("refund_sign");
      } else if (type && type !== "card payment" && !(type === "debit" && amountMinor < 0n)) reviewReasons.push("source_type");
      let feeMinor: bigint | undefined;
      if (feeColumn && sourceRow[feeColumn]?.trim()) {
        try { feeMinor = money(feeColumn); }
        catch (error) {
          if (error instanceof Error && error.message.includes("numeric convention")) throw error;
          reviewReasons.push("fee_semantics");
        }
      }
      if (feeMinor !== undefined && feeMinor !== 0n) reviewReasons.push("fee_semantics");
      const sourceDate = sourceRow[mapping.dateColumn] ?? "";
      const postedDate = parseDate(sourceDate, mapping.dateFormat);
      const postedAt = mapping.dateFormat === "iso" ? parseTimestamp(sourceDate, mapping.timestampTimezone) : undefined;
      return [{
        rowNumber: index + 2,
        accountName,
        postedOn: postedAt ? calendarDate(postedAt, mapping.calendarTimezone) : postedDate,
        ...(postedAt ? { postedAt } : {}),
        ...(mapping.calendarTimezone ? { calendarTimezone: mapping.calendarTimezone } : {}),
        description,
        amountMinor,
        currencyCode,
        status: mapping.statusColumn ? parseTransactionStatus(sourceRow[mapping.statusColumn]) : "posted",
        kind, reviewReasons,
        ...(sourceType ? { sourceType } : {}),
        ...(feeMinor !== undefined ? { feeMinor } : {}),
        sourceRow: rows[index],
        ...(mapping.merchantColumn && sourceRow[mapping.merchantColumn]?.trim() ? { merchant: sourceRow[mapping.merchantColumn].trim() } : {}),
        ...(mapping.categoryColumn && sourceRow[mapping.categoryColumn]?.trim() ? { category: sourceRow[mapping.categoryColumn].trim() } : {}),
        ...(mapping.externalIdColumn && sourceRow[mapping.externalIdColumn]?.trim() ? { externalId: sourceRow[mapping.externalIdColumn].trim() } : {}),
        ...(mapping.balanceColumn && sourceRow[mapping.balanceColumn]?.trim() ? { balanceMinor: money(mapping.balanceColumn) } : {}),
      }];
    } catch (error) {
      unresolvedRows.push({ rowNumber: index + 2, sourceRow: rows[index], reason: "invalid_row",
        message: `Row ${index + 2}: ${error instanceof Error ? error.message : String(error)}` });
      return [];
    }
  });
  const groups = new Map<string, MappedRow[]>();
  for (const row of mapped) {
    const key = JSON.stringify([row.accountName, row.currencyCode]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
    if (row.feeMinor !== undefined && row.feeMinor !== 0n) row.feeEvidence = { treatment: "unknown" };
  }
  for (const group of groups.values()) {
    // Missing/excluded observations cannot establish adjacent statement balances.
    if (unresolvedRows.length || excludedRows.length) continue;
    if (group.some(row => !row.postedAt)) continue;
    group.sort((a, b) => a.postedAt!.localeCompare(b.postedAt!));
    for (let index = 1; index < group.length; index++) {
      const row = group[index], previous = group[index - 1], next = group[index + 1];
      if (!row.feeEvidence || row.status !== "posted" || previous.status !== "posted" || row.balanceMinor === undefined || previous.balanceMinor === undefined ||
          row.postedAt === previous.postedAt || row.postedAt === next?.postedAt) continue;
      const deltaMinor = row.balanceMinor - previous.balanceMinor;
      const fee = row.feeMinor! < 0n ? -row.feeMinor! : row.feeMinor!;
      row.feeEvidence = { treatment: deltaMinor === row.amountMinor ? "included" : deltaMinor === row.amountMinor - fee ? "additional" : "unknown", deltaMinor, previousRowNumber: previous.rowNumber };
    }
  }
  return { mapped, unresolvedRows, excludedRows, correctedRows: mapped.filter(row => decisions.get(row.rowNumber)?.action === "correct").length };
}

export function previewImport(rows: SourceRow[], input: unknown) {
  const mapping = validateMapping(input, rows);
  const { mapped, unresolvedRows, excludedRows, correctedRows } = inspectRows(rows, mapping);
  const dates = mapped.map((row) => row.postedOn).sort();
  return {
    accountName: mapping.accountName,
    currencyCode: mapping.currencyCode,
    accounts: Array.from(mapped.reduce((groups, row) => {
      const key = JSON.stringify([row.accountName, row.currencyCode]);
      const group = groups.get(key) ?? { accountName: row.accountName, currencyCode: row.currencyCode, rows: 0 };
      group.rows++;
      groups.set(key, group);
      return groups;
    }, new Map<string, { accountName: string; currencyCode: string; rows: number }>()).values()),
    totalRows: rows.length,
    acceptedRows: mapped.length,
    unresolvedRows,
    excludedRows,
    correctedRows,
    pendingRows: mapped.filter((row) => row.status === "pending").length,
    postedRows: mapped.filter((row) => row.status === "posted").length,
    classificationReviewRows: mapped.filter(row => row.reviewReasons.length > 0).length,
    timestampReviewRequired: reviewedSourceRows(rows, mapping).some(row => row && /[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(row[mapping.dateColumn]?.trim() ?? "")),
    dateRange: { from: dates[0], to: dates[dates.length - 1] },
    examples: mapped.slice(0, 5),
  };
}

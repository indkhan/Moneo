import Papa from "papaparse";
import ExcelJS from "exceljs";
import { z } from "zod";
import { minorDigits } from "@/lib/finance/fx";
import { calendarDate, reviewedLocalTimestamp } from "@/lib/finance/calendar";

const timezoneSchema = z.string().max(100).refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}, "Invalid timestamp timezone");

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
  const naive = rows.some(row => /[ T]\d{2}:\d{2}:\d{2}$/.test(row[mapping.dateColumn]?.trim() ?? ""));
  if (naive && (!mapping.timestampTimezone || !mapping.timestampTimezoneConfirmed))
    throw new Error("Review and confirm the source timestamp timezone before importing");
  mapRows(rows, mapping);
  return mapping;
}

export function proposeStatementTimezones(rows: SourceRow[], mapping: ImportMapping, workspaceTimezone = "Europe/Berlin"): ImportMapping {
  const naive = rows.some(row => /[ T]\d{2}:\d{2}:\d{2}$/.test(row[mapping.dateColumn]?.trim() ?? ""));
  return { ...mapping, calendarTimezone: workspaceTimezone,
    ...(naive ? { timestampTimezone: mapping.timestampTimezone ?? workspaceTimezone,
      timestampTimezoneConfirmed: mapping.timestampTimezoneConfirmed ?? false } : {}) };
}

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
  const mapping = mappingSchema.parse(input);
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

export function parseAmountMinor(input: string, currencyCode: string = "EUR"): bigint {
  const digits = minorDigits(currencyCode);
  let value = input.trim().replace(/\s/g, "").replace(/[€$£]/g, "");
  if (!/^(?:\(\d[\d.,]*\)|[-+]?\d[\d.,]*|\d[\d.,]*-)$/.test(value)) throw new Error(`Invalid amount: ${input}`);
  const negative = /^\(.*\)$/.test(value) || value.startsWith("-") || value.endsWith("-");
  value = value.replace(/[()\-+]/g, "");
  const comma = value.lastIndexOf(",");
  const dot = value.lastIndexOf(".");
  if ((comma < 0 || dot < 0) && /^\d{1,3}([.,]\d{3})+$/.test(value)) {
    const whole = BigInt(value.replace(/[.,]/g, ""));
    return databaseMinor(whole * (negative ? -pow10(digits) : pow10(digits)));
  }
  const decimal = comma > dot ? "," : ".";
  const parts = value.split(decimal);
  if (parts.length > 2 || !/^(\d{1,3}([.,]\d{3})*|\d+)$/.test(parts[0]) ||
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
    ? /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:Z|[+-]\d{2}:[0-5]\d)?)?$/.exec(value)
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
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})?$/.exec(value.trim());
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
  const mapping = validateMapping(input, rows);
  const mapped: MappedRow[] = rows.map((sourceRow, index) => {
    try {
      const description = sourceRow[mapping.descriptionColumn]?.trim();
      if (!description) throw new Error("Missing description");
      const currencyCode = (mapping.currencyColumn ? sourceRow[mapping.currencyColumn] : mapping.currencyCode).trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currencyCode)) throw new Error("Invalid currency");
      const accountValue = mapping.accountColumn ? sourceRow[mapping.accountColumn]?.trim() : undefined;
      const productValue = mapping.productColumn ? sourceRow[mapping.productColumn]?.trim() : undefined;
      const routes = mapping.accountRoutes?.filter(route => route.currencyCode === currencyCode &&
        route.accountValue === accountValue && route.productValue === productValue);
      if ((mapping.accountColumn || mapping.productColumn || mapping.accountRoutes) && routes?.length !== 1)
        throw new Error("Review account routing: each account/product/currency requires exactly one route");
      const accountName = routes?.[0]?.accountName ?? mapping.accountName;
      let amountMinor: bigint;
      if (mapping.amountColumn) {
        amountMinor = parseAmountMinor(sourceRow[mapping.amountColumn] ?? "", currencyCode);
        if (mapping.amountSign === "outflow-positive") amountMinor = -amountMinor;
      } else {
        const debit = sourceRow[mapping.debitColumn!] ?? "";
        const credit = sourceRow[mapping.creditColumn!] ?? "";
        if (Boolean(debit.trim()) === Boolean(credit.trim())) throw new Error("Expected exactly one debit or credit value");
        amountMinor = credit.trim() ? parseAmountMinor(credit, currencyCode) : -parseAmountMinor(debit, currencyCode);
        if ((credit.trim() && amountMinor < 0n) || (debit.trim() && amountMinor > 0n))
          throw new Error("Debit and credit values must be positive");
        if (amountMinor === 0n) throw new Error("Zero debit or credit");
      }
      const header = (name: string) => Object.keys(sourceRow).find(key => key.trim().toLowerCase() === name);
      const typeColumn = mapping.typeColumn ?? header("type");
      const feeColumn = mapping.feeColumn ?? header("fee");
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
        try { feeMinor = parseAmountMinor(sourceRow[feeColumn], currencyCode); }
        catch { reviewReasons.push("fee_semantics"); }
      }
      if (feeMinor !== undefined && feeMinor !== 0n) reviewReasons.push("fee_semantics");
      const sourceDate = sourceRow[mapping.dateColumn] ?? "";
      const postedDate = parseDate(sourceDate, mapping.dateFormat);
      const postedAt = mapping.dateFormat === "iso" ? parseTimestamp(sourceDate, mapping.timestampTimezone) : undefined;
      return {
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
        sourceRow,
        ...(mapping.merchantColumn && sourceRow[mapping.merchantColumn]?.trim() ? { merchant: sourceRow[mapping.merchantColumn].trim() } : {}),
        ...(mapping.categoryColumn && sourceRow[mapping.categoryColumn]?.trim() ? { category: sourceRow[mapping.categoryColumn].trim() } : {}),
        ...(mapping.externalIdColumn && sourceRow[mapping.externalIdColumn]?.trim() ? { externalId: sourceRow[mapping.externalIdColumn].trim() } : {}),
        ...(mapping.balanceColumn && sourceRow[mapping.balanceColumn]?.trim() ? { balanceMinor: parseAmountMinor(sourceRow[mapping.balanceColumn], currencyCode) } : {}),
      };
    } catch (error) {
      throw new Error(`Row ${index + 2}: ${error instanceof Error ? error.message : String(error)}`);
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
  return mapped;
}

export function previewImport(rows: SourceRow[], input: unknown) {
  const mapping = validateMapping(input, rows);
  const mapped = mapRows(rows, mapping);
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
    totalRows: mapped.length,
    pendingRows: mapped.filter((row) => row.status === "pending").length,
    postedRows: mapped.filter((row) => row.status === "posted").length,
    classificationReviewRows: mapped.filter(row => row.reviewReasons.length > 0).length,
    timestampReviewRequired: rows.some(row => /[ T]\d{2}:\d{2}:\d{2}$/.test(row[mapping.dateColumn]?.trim() ?? "")),
    dateRange: { from: dates[0], to: dates[dates.length - 1] },
    examples: mapped.slice(0, 5),
  };
}

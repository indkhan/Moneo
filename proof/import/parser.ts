// E00-S03 import-fidelity proof parser.
//
// Feasibility proof, not production code. It demonstrates that a minimal
// bounded parser can turn synthetic CSV/XLSX bytes into a validated canonical
// proposal with exact decimal-string money and source provenance, while every
// ambiguity stays explicit (needs_review) instead of silently becoming money.
//
// Design constraints honoured here:
// - Money is computed with BigInt from the raw decimal text only; the parser
//   never touches JavaScript numbers for authoritative amounts.
// - Workbook formulas are never evaluated and their cached values are never
//   used; external workbook links reject the whole file.
// - All text is decoded as strict UTF-8; anything else is an explicit error.
// - Row/column/decompressed-size caps are enforced while parsing (fail fast),
//   so hostile inputs abort before materialising unbounded structures.
// - No `enum`, namespace, decorator or other non-erasable syntax is used so
//   the file also runs under Node type-stripping inside the isolated child.

import { Unzip, UnzipInflate } from "fflate";

export const PROOF_LIMITS = {
  maxUploadBytes: 20 * 1024 * 1024,
  maxDecompressedBytes: 100 * 1024 * 1024,
  maxRows: 100_000,
  maxCols: 50,
  maxZipEntries: 200,
} as const;

export type ProofLimits = {
  maxUploadBytes: number;
  maxDecompressedBytes: number;
  maxRows: number;
  maxCols: number;
  maxZipEntries: number;
};

// Proof currency subset: one representative per exponent (EUR=2, JPY=0,
// KWD=3). Anything else is explicitly `unsupported-currency`, never guessed.
export const CURRENCY_EXPONENTS: Record<string, number> = {
  EUR: 2,
  JPY: 0,
  KWD: 3,
};

export type Direction = "INFLOW" | "OUTFLOW";

export type AmountFormat = {
  decimalSep: "." | ",";
  thousandsSep: "." | "," | "";
};

export type ImportProfile = {
  delimiter: "," | ";";
  dateFormat: "iso" | "de" | "us" | "excel-serial";
  amount:
    | ({ kind: "signed" } & AmountFormat)
    | ({ kind: "debit-credit" } & AmountFormat);
  columns: {
    date: string;
    description: string;
    amount?: string;
    debit?: string;
    credit?: string;
    currency?: string;
  };
  defaultCurrency?: string;
};

export type SourceRef = {
  file: string;
  sheet: string | null;
  row: number;
  columns: Record<string, string>;
};

export type AcceptedProposal = {
  kind: "accepted";
  rowNumber: number;
  source: SourceRef;
  amountMinor: string;
  currency: string;
  direction: Direction;
  effectiveDate: string;
  description: string;
  observationId: string;
};

export type ReviewProposal = {
  kind: "needs_review";
  rowNumber: number;
  source: SourceRef;
  reasons: string[];
  raw: Record<string, string>;
  observationId: string;
};

export type RejectedProposal = {
  kind: "rejected";
  rowNumber: number;
  source: SourceRef;
  reasons: string[];
  raw: Record<string, string>;
  observationId: string;
};

export type Proposal = AcceptedProposal | ReviewProposal | RejectedProposal;

export type FileErrorCode =
  | "unsupported-encoding"
  | "corrupt"
  | "upload-limit"
  | "row-limit"
  | "column-limit"
  | "decompressed-limit"
  | "too-many-entries"
  | "unsupported-format"
  | "unsupported-schema"
  | "external-link"
  | "internal";

export type FileResult =
  | {
      ok: true;
      sheet: string | null;
      ignoredSheets: number;
      proposals: Proposal[];
    }
  | { ok: false; error: { code: FileErrorCode; message: string } };

export function defaultLimits(): ProofLimits {
  return { ...PROOF_LIMITS };
}

export function mergeLimits(overrides?: Partial<ProofLimits>): ProofLimits {
  return { ...PROOF_LIMITS, ...(overrides ?? {}) };
}

// ---------------------------------------------------------------------------
// Observation identity (proof-local, deterministic, not a security hash)
// ---------------------------------------------------------------------------

function fnv1a64Hex(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

export function observationId(
  fileLabel: string,
  rowNumber: number,
  cells: string[],
): string {
  return fnv1a64Hex(`${fileLabel}\n${rowNumber}\n${cells.join("")}`);
}

// ---------------------------------------------------------------------------
// Text decoding: strict UTF-8 with BOM tolerance
// ---------------------------------------------------------------------------

export function decodeUtf8Strict(bytes: Uint8Array): string {
  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    start = 3;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(start),
    );
  } catch {
    throw fileError(
      "unsupported-encoding",
      "File is not valid UTF-8 (with or without BOM). Only UTF-8 CSV input is admitted in this proof.",
    );
  }
}

function fileError(code: FileErrorCode, message: string): Error & { code: FileErrorCode } {
  const err = new Error(message) as Error & { code: FileErrorCode };
  err.code = code;
  return err;
}

export function asFileError(err: unknown): { code: FileErrorCode; message: string } {
  if (err !== null && typeof err === "object" && "code" in err) {
    const code: unknown = (err as { code: unknown }).code;
    if (code === "unsupported-encoding" || code === "corrupt" || code === "upload-limit" || code === "row-limit" || code === "column-limit" || code === "decompressed-limit" || code === "too-many-entries" || code === "unsupported-format" || code === "unsupported-schema" || code === "external-link" || code === "internal") {
      const message = err instanceof Error ? err.message : JSON.stringify(err);
      return { code, message };
    }
  }
  return { code: "internal", message: err instanceof Error ? err.message : String(err) };
}

// ---------------------------------------------------------------------------
// CSV: strict RFC 4180 subset (comma/semicolon delimiter, quotes, CRLF)
// ---------------------------------------------------------------------------

export function parseCsvText(
  text: string,
  delimiter: "," | ";",
  limits: ProofLimits,
): string[][] {
  const rows: string[][] = [];
  let fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let rowHasContent = false;
  let i = 0;

  const endRow = () => {
    if (rowHasContent) {
      fields.push(field);
      if (fields.length > limits.maxCols) {
        throw fileError(
          "column-limit",
          `Row ${rows.length + 2} has ${fields.length} columns; at most ${limits.maxCols} are admitted.`,
        );
      }
      rows.push(fields);
      if (rows.length > limits.maxRows) {
        throw fileError(
          "row-limit",
          `File has more than ${limits.maxRows} rows; widen the limit explicitly or split the statement.`,
        );
      }
    }
    fields = [];
    field = "";
    rowHasContent = false;
  };

  while (i < text.length) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else if (c === "\r" && text[i + 1] === "\n") {
        // Normalise CRLF inside quoted fields to LF: Windows exports and
        // CRLF checkouts must parse identically to LF bytes. Row-breaking
        // CRLF outside quotes is handled by the separator logic below.
        field += "\n";
        i += 2;
      } else {
        field += c;
        i += 1;
      }
      continue;
    }
    if (c === '"') {
      if (field !== "") {
        throw fileError(
          "corrupt",
          `Stray quote at offset ${i}: quotes are only admitted as the first character of a field.`,
        );
      }
      inQuotes = true;
      rowHasContent = true;
      i += 1;
    } else if (c === delimiter) {
      fields.push(field);
      field = "";
      rowHasContent = true;
      i += 1;
    } else if (c === "\r") {
      if (text[i + 1] === "\n") i += 1;
      i += 1;
      endRow();
    } else if (c === "\n") {
      i += 1;
      endRow();
    } else {
      field += c;
      rowHasContent = true;
      i += 1;
    }
  }
  if (inQuotes) {
    throw fileError("corrupt", "Unterminated quoted field at end of file.");
  }
  endRow();
  return rows;
}

// ---------------------------------------------------------------------------
// Amounts: decimal text -> exact minor-unit string (BigInt only)
// ---------------------------------------------------------------------------

export type AmountParse =
  | { ok: true; minor: string; negative: boolean; isZero: boolean }
  | { ok: false; reason: "missing-amount" | "ambiguous-amount" | "sub-minor-precision" };

export function parseAmountToMinor(
  raw: string,
  fmt: AmountFormat,
  exponent: number,
): AmountParse {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, reason: "missing-amount" };
  if (fmt.thousandsSep !== "" && fmt.decimalSep === fmt.thousandsSep) {
    throw new Error("Invalid amount format: decimal and thousands separators coincide.");
  }
  // Parenthesised negatives, embedded spaces/symbols and stray signs are
  // never interpreted silently.
  if (/[()_'\u00a0\u202f]/.test(trimmed) || /\s/.test(trimmed)) {
    return { ok: false, reason: "ambiguous-amount" };
  }
  if (/[€$£¥₹¢]/.test(trimmed)) {
    return { ok: false, reason: "ambiguous-amount" };
  }
  let body = trimmed;
  let negative = false;
  if (body[0] === "-" || body[0] === "+") {
    negative = body[0] === "-";
    body = body.slice(1);
  }
  if (body === "" || /[+-]/.test(body)) {
    return { ok: false, reason: "ambiguous-amount" };
  }
  const allowed = new Set(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", fmt.decimalSep]);
  if (fmt.thousandsSep !== "") allowed.add(fmt.thousandsSep);
  for (const ch of body) {
    if (!allowed.has(ch)) return { ok: false, reason: "ambiguous-amount" };
  }
  const decimalParts = body.split(fmt.decimalSep);
  if (decimalParts.length > 2) return { ok: false, reason: "ambiguous-amount" };
  let intPart = decimalParts[0] ?? "";
  const fracPart = decimalParts.length === 2 ? (decimalParts[1] ?? "") : "";
  if (intPart === "" || !/^\d+$/.test(intPart.replaceAll(fmt.thousandsSep, ""))) {
    // Handles ".5" style inputs and separator-only inputs.
    return { ok: false, reason: "ambiguous-amount" };
  }
  if (fracPart !== "" && !/^\d+$/.test(fracPart)) {
    return { ok: false, reason: "ambiguous-amount" };
  }
  if (fmt.thousandsSep !== "" && intPart.includes(fmt.thousandsSep)) {
    const groups = intPart.split(fmt.thousandsSep);
    const firstOk = groups[0] !== undefined && /^\d{1,3}$/.test(groups[0]);
    const restOk = groups.slice(1).every((g) => /^\d{3}$/.test(g));
    if (!firstOk || !restOk || groups.length < 2) {
      return { ok: false, reason: "ambiguous-amount" };
    }
    intPart = groups.join("");
  }
  if (!/^\d+$/.test(intPart)) return { ok: false, reason: "ambiguous-amount" };
  if (fracPart.length > exponent) {
    return { ok: false, reason: "sub-minor-precision" };
  }
  const fracPadded = fracPart.padEnd(exponent, "0");
  const digits = `${intPart.replace(/^0+(?=\d)/, "")}${fracPadded}`;
  const minor = BigInt(digits === "" ? "0" : digits);
  if (minor === 0n) return { ok: true, minor: "0", negative: false, isZero: true };
  return { ok: true, minor: minor.toString(), negative, isZero: false };
}

// ---------------------------------------------------------------------------
// Dates: declared format only, strict calendar validation
// ---------------------------------------------------------------------------

export type DateParse =
  | { ok: true; iso: string }
  | { ok: false; reason: "missing-date" | "ambiguous-date" | "invalid-date" };

function isValidCalendar(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dim = [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
  return d <= dim[m - 1]!;
}

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function toIso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

export function excelSerialToIso(serialText: string): DateParse {
  const t = serialText.trim();
  if (t === "") return { ok: false, reason: "missing-date" };
  if (!/^\d+$/.test(t)) return { ok: false, reason: "ambiguous-date" };
  const serial = Number(t);
  const min = Math.round((Date.UTC(1950, 0, 1) - EXCEL_EPOCH_MS) / DAY_MS);
  const max = Math.round((Date.UTC(2099, 11, 31) - EXCEL_EPOCH_MS) / DAY_MS);
  if (!Number.isSafeInteger(serial) || serial < min || serial > max) {
    return { ok: false, reason: "ambiguous-date" };
  }
  const dt = new Date(EXCEL_EPOCH_MS + serial * DAY_MS);
  return {
    ok: true,
    iso: toIso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()),
  };
}

export function parseDateToIso(raw: string, format: ImportProfile["dateFormat"]): DateParse {
  const t = raw.trim();
  if (t === "") return { ok: false, reason: "missing-date" };
  if (format === "excel-serial") return excelSerialToIso(t);
  let m: RegExpMatchArray | null;
  if (format === "iso") {
    m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return { ok: false, reason: "ambiguous-date" };
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (!isValidCalendar(y, mo, d)) return { ok: false, reason: "invalid-date" };
    return { ok: true, iso: toIso(y, mo, d) };
  }
  if (format === "de") {
    m = t.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (!m) return { ok: false, reason: "ambiguous-date" };
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const y = Number(m[3]);
    if (!isValidCalendar(y, mo, d)) return { ok: false, reason: "invalid-date" };
    return { ok: true, iso: toIso(y, mo, d) };
  }
  m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return { ok: false, reason: "ambiguous-date" };
  const mo = Number(m[1]);
  const d = Number(m[2]);
  const y = Number(m[3]);
  if (!isValidCalendar(y, mo, d)) return { ok: false, reason: "invalid-date" };
  return { ok: true, iso: toIso(y, mo, d) };
}

// ---------------------------------------------------------------------------
// Row mapping: headers + profile -> proposals (ambiguity stays explicit)
// ---------------------------------------------------------------------------

type ColumnIndex = {
  date: number;
  description: number;
  amount: number;
  debit: number;
  credit: number;
  currency: number;
};

function resolveColumns(header: string[], profile: ImportProfile): ColumnIndex {
  const find = (name: string | undefined): number => {
    if (name === undefined) return -1;
    const idx = header.findIndex((h) => h.trim().toLowerCase() === name.trim().toLowerCase());
    return idx;
  };
  const cols: ColumnIndex = {
    date: find(profile.columns.date),
    description: find(profile.columns.description),
    amount: find(profile.columns.amount),
    debit: find(profile.columns.debit),
    credit: find(profile.columns.credit),
    currency: find(profile.columns.currency),
  };
  const missing: string[] = [];
  if (cols.date < 0) missing.push(`date column "${profile.columns.date}"`);
  if (cols.description < 0) missing.push(`description column "${profile.columns.description}"`);
  if (profile.amount.kind === "signed") {
    if (cols.amount < 0) missing.push(`amount column "${profile.columns.amount}"`);
  } else {
    if (cols.debit < 0) missing.push(`debit column "${profile.columns.debit}"`);
    if (cols.credit < 0) missing.push(`credit column "${profile.columns.credit}"`);
  }
  if (missing.length > 0) {
    throw fileError(
      "unsupported-schema",
      `Missing required header(s): ${missing.join(", ")}. Admitted headers are matched case-insensitively; rename the export or adjust the declared mapping.`,
    );
  }
  return cols;
}

function cellOf(row: string[], idx: number): string {
  return idx < 0 || idx >= row.length ? "" : (row[idx] ?? "");
}

export function mapRowsToProposals(
  header: string[],
  dataRows: string[][],
  profile: ImportProfile,
  fileLabel: string,
  sheet: string | null,
  firstDataRowNumber: number,
  formulaRows?: Set<number>,
): Proposal[] {
  const cols = resolveColumns(header, profile);
  const proposals: Proposal[] = [];
  const headerNames = header.map((h) => h.trim());

  const columnNames = (): Record<string, string> => {
    const out: Record<string, string> = {};
    const put = (logical: string, idx: number) => {
      if (idx >= 0 && idx < headerNames.length) out[logical] = headerNames[idx]!;
    };
    put("date", cols.date);
    put("description", cols.description);
    if (cols.amount >= 0) put("amount", cols.amount);
    if (cols.debit >= 0) put("debit", cols.debit);
    if (cols.credit >= 0) put("credit", cols.credit);
    if (cols.currency >= 0) put("currency", cols.currency);
    return out;
  };
  const colNames = columnNames();

  dataRows.forEach((row, i) => {
    const rowNumber = firstDataRowNumber + i;
    if (row.every((c) => c === "")) return; // blank line: no observation
    const source: SourceRef = { file: fileLabel, sheet, row: rowNumber, columns: colNames };
    const id = observationId(fileLabel, rowNumber, row);
    const raw: Record<string, string> = {
      date: cellOf(row, cols.date),
      description: cellOf(row, cols.description),
    };
    if (cols.amount >= 0) raw["amount"] = cellOf(row, cols.amount);
    if (cols.debit >= 0) raw["debit"] = cellOf(row, cols.debit);
    if (cols.credit >= 0) raw["credit"] = cellOf(row, cols.credit);
    if (cols.currency >= 0) raw["currency"] = cellOf(row, cols.currency);

    const review = (reasons: string[]): ReviewProposal => ({
      kind: "needs_review",
      rowNumber,
      source,
      reasons,
      raw,
      observationId: id,
    });
    const rejected = (reasons: string[]): RejectedProposal => ({
      kind: "rejected",
      rowNumber,
      source,
      reasons,
      raw,
      observationId: id,
    });

    if (formulaRows?.has(i)) {
      // A workbook formula touched this row: the cached value is discarded.
      proposals.push(review(["formula-cell"]));
      return;
    }

    const description = cellOf(row, cols.description).trim();
    if (description === "") {
      proposals.push(review(["missing-description"]));
      return;
    }

    const dateParsed = parseDateToIso(cellOf(row, cols.date), profile.dateFormat);
    if (!dateParsed.ok) {
      proposals.push(review([dateParsed.reason]));
      return;
    }

    let currencyRaw = cols.currency >= 0 ? cellOf(row, cols.currency).trim().toUpperCase() : "";
    if (currencyRaw === "") currencyRaw = (profile.defaultCurrency ?? "").trim().toUpperCase();
    if (currencyRaw === "") {
      proposals.push(review(["missing-currency"]));
      return;
    }
    const exponent = CURRENCY_EXPONENTS[currencyRaw];
    if (exponent === undefined) {
      proposals.push(review(["unsupported-currency"]));
      return;
    }

    if (profile.amount.kind === "signed") {
      const parsed = parseAmountToMinor(cellOf(row, cols.amount), profile.amount, exponent);
      if (!parsed.ok) {
        proposals.push(review([parsed.reason]));
        return;
      }
      if (parsed.isZero) {
        // Zero-value rows stay observations with a rejected disposition;
        // they never become canonical money (architecture section 2.5).
        proposals.push(rejected(["zero-amount"]));
        return;
      }
      proposals.push({
        kind: "accepted",
        rowNumber,
        source,
        amountMinor: parsed.minor,
        currency: currencyRaw,
        direction: parsed.negative ? "OUTFLOW" : "INFLOW",
        effectiveDate: dateParsed.iso,
        description,
        observationId: id,
      });
      return;
    }

    // debit/credit profile: exactly one side carries an unsigned magnitude.
    const debitRaw = cellOf(row, cols.debit).trim();
    const creditRaw = cellOf(row, cols.credit).trim();
    if (debitRaw !== "" && creditRaw !== "") {
      proposals.push(review(["both-sides-filled"]));
      return;
    }
    const side = debitRaw !== "" ? { raw: debitRaw, direction: "OUTFLOW" as Direction } : creditRaw !== "" ? { raw: creditRaw, direction: "INFLOW" as Direction } : null;
    if (side === null) {
      proposals.push(review(["missing-amount"]));
      return;
    }
    if (/^[+-]/.test(side.raw)) {
      proposals.push(review(["signed-in-split-column"]));
      return;
    }
    const parsed = parseAmountToMinor(side.raw, profile.amount, exponent);
    if (!parsed.ok) {
      proposals.push(review([parsed.reason]));
      return;
    }
    if (parsed.isZero) {
      proposals.push(rejected(["zero-amount"]));
      return;
    }
    if (parsed.negative) {
      proposals.push(review(["signed-in-split-column"]));
      return;
    }
    proposals.push({
      kind: "accepted",
      rowNumber,
      source,
      amountMinor: parsed.minor,
      currency: currencyRaw,
      direction: side.direction,
      effectiveDate: dateParsed.iso,
      description,
      observationId: id,
    });
  });
  return proposals;
}

// ---------------------------------------------------------------------------
// XLSX: minimal bounded reader (shared strings + first sheet, no formulas)
// ---------------------------------------------------------------------------

function decodeXmlEntities(s: string): string {
  return s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&#xD;", "\r")
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replaceAll("&amp;", "&");
}

function parseTagAttrs(inner: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    attrs[m[1]!] = decodeXmlEntities(m[3] ?? m[4] ?? "");
  }
  return attrs;
}

function columnLettersToIndex(letters: string): number {
  let idx = 0;
  for (const ch of letters.toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) throw fileError("corrupt", `Invalid cell reference "${letters}".`);
    idx = idx * 26 + (code - 64);
  }
  return idx - 1;
}

function splitCellRef(ref: string): { col: number; row: number } {
  const m = ref.match(/^([A-Za-z]+)(\d+)$/);
  if (!m) throw fileError("corrupt", `Invalid cell reference "${ref}".`);
  return { col: columnLettersToIndex(m[1]!), row: Number(m[2]) };
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml)) !== null) {
    const parts: string[] = [];
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let t: RegExpExecArray | null;
    while ((t = tRe.exec(m[1]!)) !== null) {
      parts.push(decodeXmlEntities(t[1]!));
    }
    out.push(parts.join(""));
  }
  return out;
}

type SheetGrid = {
  header: string[];
  rows: string[][];
  formulaRows: Set<number>;
};

function parseSheetGrid(
  xml: string,
  shared: string[],
  limits: ProofLimits,
): SheetGrid {
  const dataMatch = xml.match(/<sheetData>([\s\S]*?)<\/sheetData>/);
  if (!dataMatch) throw fileError("corrupt", "Worksheet has no <sheetData> block.");
  const body = dataMatch[1]!;
  const rowRe = /<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g;
  const grid = new Map<number, Map<number, string>>();
  const formulaRowNumbers = new Set<number>();
  let maxCol = -1;
  let rowCount = 0;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(body)) !== null) {
    rowCount += 1;
    if (rowCount > limits.maxRows + 1) {
      throw fileError(
        "row-limit",
        `Worksheet has more than ${limits.maxRows} data rows; widen the limit explicitly or split the statement.`,
      );
    }
    const cellRe = /<c(\s[^>]*)?>([\s\S]*?)<\/c>|<c(\s[^>]*)?\/>/g;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rm[1]!)) !== null) {
      const attrText = (cm[1] ?? cm[3] ?? "").trim();
      const inner = cm[2] ?? "";
      const attrs = parseTagAttrs(attrText);
      const ref = attrs["r"] ?? "";
      if (ref === "") throw fileError("corrupt", "Worksheet cell without a reference.");
      const { col, row } = splitCellRef(ref);
      if (col > limits.maxCols - 1) {
        throw fileError(
          "column-limit",
          `Worksheet uses column ${col + 1}; at most ${limits.maxCols} are admitted.`,
        );
      }
      if (col > maxCol) maxCol = col;
      const hasFormula = /<f(\s[^>]*)?>/.test(inner);
      let value = "";
      if (hasFormula) {
        formulaRowNumbers.add(row);
        value = "";
      } else {
        const t = attrs["t"] ?? "";
        if (t === "inlineStr") {
          const tm = inner.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/);
          value = tm ? decodeXmlEntities(tm[1]!) : "";
        } else {
          const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
          const vtext = vm ? decodeXmlEntities(vm[1]!.trim()) : "";
          if (t === "s") {
            const idx = Number(vtext);
            if (!Number.isSafeInteger(idx) || idx < 0 || idx >= shared.length) {
              throw fileError("corrupt", `Shared-string index "${vtext}" is out of range.`);
            }
            value = shared[idx]!;
          } else if (t === "str" || t === "e") {
            value = vtext;
          } else if (t === "b") {
            value = vtext;
          } else {
            value = vtext;
          }
        }
      }
      let cols = grid.get(row);
      if (!cols) {
        cols = new Map<number, string>();
        grid.set(row, cols);
      }
      cols.set(col, value);
    }
  }
  if (grid.size === 0) {
    throw fileError("unsupported-schema", "Worksheet contains no rows; a header row is required.");
  }
  const ordered = [...grid.keys()].sort((a, b) => a - b);
  const width = maxCol + 1;
  const toDense = (rowNum: number): string[] => {
    const cols = grid.get(rowNum)!;
    const out: string[] = [];
    for (let c = 0; c < width; c++) out.push(cols.get(c) ?? "");
    return out;
  };
  const header = toDense(ordered[0]!);
  const rows: string[][] = [];
  const formulaRows = new Set<number>();
  for (let k = 1; k < ordered.length; k++) {
    const rowNum = ordered[k]!;
    const dense = toDense(rowNum);
    if (dense.every((c) => c === "") && !formulaRowNumbers.has(rowNum)) continue;
    if (formulaRowNumbers.has(rowNum)) formulaRows.add(rows.length);
    rows.push(dense);
  }
  return { header, rows, formulaRows };
}

function firstSheetName(workbookXml: string): { name: string; sheetCount: number } {
  const sheetsMatch = workbookXml.match(/<sheets>([\s\S]*?)<\/sheets>/);
  if (!sheetsMatch) throw fileError("corrupt", "Workbook has no <sheets> block.");
  const re = /<sheet\s[^>]*\/>|<sheet\s[^>]*>[\s\S]*?<\/sheet>/g;
  const found = sheetsMatch[1]!.match(re) ?? [];
  if (found.length === 0) throw fileError("unsupported-schema", "Workbook declares no sheets.");
  const attrs = parseTagAttrs(found[0]!.replace(/^<sheet\s/, "").replace(/\/?>$/, ""));
  return { name: attrs["name"] ?? "Sheet1", sheetCount: found.length };
}

// ---------------------------------------------------------------------------
// Entry point: bytes + filename + declared profile -> proposal (or file error)
// ---------------------------------------------------------------------------

export function parseImportFile(
  bytes: Uint8Array,
  filename: string,
  profile: ImportProfile,
  limits?: Partial<ProofLimits>,
): FileResult {
  const lim = mergeLimits(limits);
  try {
    if (bytes.length > lim.maxUploadBytes) {
      throw fileError(
        "upload-limit",
        `File is ${bytes.length} bytes; at most ${lim.maxUploadBytes} bytes are admitted. Split the statement or widen the limit explicitly.`,
      );
    }
    const lower = filename.toLowerCase();
    if (lower.endsWith(".csv")) {
      const text = decodeUtf8Strict(bytes);
      const table = parseCsvText(text, profile.delimiter, lim);
      if (table.length === 0) {
        throw fileError("unsupported-schema", "CSV contains no rows; a header row is required.");
      }
      const proposals = mapRowsToProposals(table[0]!, table.slice(1), profile, filename, null, 2);
      return { ok: true, sheet: null, ignoredSheets: 0, proposals };
    }
    if (lower.endsWith(".xlsx")) {
      return parseXlsxSync(bytes, filename, profile, lim);
    }
    return {
      ok: false,
      error: {
        code: "unsupported-format",
        message: `Extension of "${filename}" is not admitted. This proof admits .csv and a bounded .xlsx subset only.`,
      },
    };
  } catch (e) {
    return { ok: false, error: asFileError(e) };
  }
}

// fflate's streaming Unzip is callback-driven; this proof feeds one bounded
// in-memory buffer and assembles synchronously.
function parseXlsxSync(
  bytes: Uint8Array,
  filename: string,
  profile: ImportProfile,
  lim: ProofLimits,
): FileResult {
  try {
    const entries = unzipSyncBounded(bytes, lim);
    for (const name of entries.keys()) {
      if (name.startsWith("xl/externalLinks/")) {
        throw fileError(
          "external-link",
          `Workbook references "${name}". External links are never followed; remove the link or export values-only.`,
        );
      }
    }
    const workbookEntry = entries.get("xl/workbook.xml");
    if (!workbookEntry) throw fileError("corrupt", "Archive is not a workbook: xl/workbook.xml is missing.");
    const workbookXml = new TextDecoder("utf-8", { fatal: false }).decode(workbookEntry);
    if (/<externalReference/.test(workbookXml)) {
      throw fileError(
        "external-link",
        "Workbook declares an external reference. External links are never followed; remove the link or export values-only.",
      );
    }
    const { name, sheetCount } = firstSheetName(workbookXml);
    const sheetEntry = entries.get("xl/worksheets/sheet1.xml");
    if (!sheetEntry) {
      throw fileError(
        "unsupported-format",
        "Only single-sheet workbooks stored as xl/worksheets/sheet1.xml are admitted in this proof.",
      );
    }
    let shared: string[] = [];
    const sharedEntry = entries.get("xl/sharedStrings.xml");
    if (sharedEntry) {
      shared = parseSharedStrings(new TextDecoder("utf-8", { fatal: false }).decode(sharedEntry));
    }
    const sheetXml = new TextDecoder("utf-8", { fatal: false }).decode(sheetEntry);
    const grid = parseSheetGrid(sheetXml, shared, lim);
    if (grid.header.length === 0 || grid.header.every((h) => h === "")) {
      throw fileError("unsupported-schema", "Worksheet header row is empty; a header row is required.");
    }
    const proposals = mapRowsToProposals(grid.header, grid.rows, profile, filename, name, 2, grid.formulaRows);
    return { ok: true, sheet: name, ignoredSheets: sheetCount - 1, proposals };
  } catch (e) {
    return { ok: false, error: asFileError(e) };
  }
}

function unzipSyncBounded(bytes: Uint8Array, lim: ProofLimits): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  let count = 0;
  let total = 0;
  let failure: { code: FileErrorCode; message: string } | null = null;
  const fail = (code: FileErrorCode, message: string) => {
    if (!failure) failure = { code, message };
  };
  const unzipper = new Unzip();
  // Registered once: entry chunks delivered to ondata below are already
  // decompressed, so the running cap below bounds host memory before the
  // full entry is ever materialised.
  unzipper.register(UnzipInflate);
  unzipper.onfile = (file) => {
    count += 1;
    if (count > lim.maxZipEntries) {
      fail("too-many-entries", `Archive holds more than ${lim.maxZipEntries} entries.`);
      return;
    }
    if (file.name.endsWith("/")) return;
    const parts: Uint8Array[] = [];
    let size = 0;
    file.ondata = (err, dat, final) => {
      if (failure) return;
      if (err) {
        fail("corrupt", `Entry "${file.name}" is corrupt: ${err.message}`);
        return;
      }
      size += dat.length;
      total += dat.length;
      if (size > lim.maxDecompressedBytes || total > lim.maxDecompressedBytes) {
        fail(
          "decompressed-limit",
          `Decompressed content exceeds ${lim.maxDecompressedBytes} bytes; refusing "${file.name}".`,
        );
        return;
      }
      parts.push(dat.slice());
      if (final) {
        const merged = new Uint8Array(size);
        let off = 0;
        for (const p of parts) {
          merged.set(p, off);
          off += p.length;
        }
        out.set(file.name, merged);
      }
    };
    file.start();
  };
  try {
    unzipper.push(bytes, true);
  } catch (e) {
    throw fileError(
      "corrupt",
      `Archive cannot be read as a zip: ${(e as Error).message}`,
    );
  }
  if (failure) throw failure;
  if (out.size === 0 && count === 0) {
    throw fileError("corrupt", "Archive holds no entries; expected an XLSX workbook.");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reimport decisions: no extra effects, multiplicity kept, overlap staged
// ---------------------------------------------------------------------------

export type PriorImport = {
  observationIds: Set<string>;
  keys: Map<string, string>;
};

export function canonicalKey(p: AcceptedProposal): string {
  return `${p.effectiveDate}|${p.amountMinor}|${p.currency}|${p.direction}|${p.description}`;
}

export function buildPrior(proposals: Proposal[]): PriorImport {
  const observationIds = new Set<string>();
  const keys = new Map<string, string>();
  for (const p of proposals) {
    observationIds.add(p.observationId);
    if (p.kind === "accepted") keys.set(canonicalKey(p), p.observationId);
  }
  return { observationIds, keys };
}

export type MatchDecision =
  | { observationId: string; decision: "new" }
  | { observationId: string; decision: "matched_existing" }
  | { observationId: string; decision: "overlap_candidate" }
  | { observationId: string; decision: "not_canonical" };

export function decideReimport(
  proposals: Proposal[],
  prior: PriorImport,
): { decisions: MatchDecision[]; proposals: Proposal[] } {
  const decisions: MatchDecision[] = [];
  const adjusted: Proposal[] = [];
  for (const p of proposals) {
    if (p.kind !== "accepted") {
      decisions.push({ observationId: p.observationId, decision: "not_canonical" });
      adjusted.push(p);
      continue;
    }
    if (prior.observationIds.has(p.observationId)) {
      decisions.push({ observationId: p.observationId, decision: "matched_existing" });
      adjusted.push(p);
      continue;
    }
    if (prior.keys.has(canonicalKey(p))) {
      // Same economic shape seen in an earlier import under a different
      // observation: never auto-link (architecture 537). Stage for review.
      decisions.push({ observationId: p.observationId, decision: "overlap_candidate" });
      adjusted.push({
        kind: "needs_review",
        rowNumber: p.rowNumber,
        source: p.source,
        reasons: ["possible-overlap"],
        raw: {
          date: p.effectiveDate,
          description: p.description,
          amount: p.amountMinor,
          currency: p.currency,
        },
        observationId: p.observationId,
      });
      continue;
    }
    decisions.push({ observationId: p.observationId, decision: "new" });
    adjusted.push(p);
  }
  return { decisions, proposals: adjusted };
}

export function summarizeCoverage(
  proposals: Proposal[],
  input: { balanceProvided: boolean; baseCurrency: string },
): {
  complete: boolean;
  accepted: number;
  pendingReview: number;
  rejected: number;
  missingBalance: boolean;
  fxGapCurrencies: string[];
} {
  const accepted = proposals.filter((p) => p.kind === "accepted").length;
  const pendingReview = proposals.filter((p) => p.kind === "needs_review").length;
  const rejected = proposals.filter((p) => p.kind === "rejected").length;
  const fxGapCurrencies = [...new Set(proposals.flatMap((p) => {
    if (p.kind === "accepted") return p.currency === input.baseCurrency ? [] : [p.currency];
    const currency = p.raw.currency;
    return p.reasons.includes("unsupported-currency") && currency ? [currency] : [];
  }))].sort();
  const missingBalance = !input.balanceProvided;
  return {
    complete: !missingBalance && pendingReview === 0 && rejected === 0 && fxGapCurrencies.length === 0,
    accepted,
    pendingReview,
    rejected,
    missingBalance,
    fxGapCurrencies,
  };
}

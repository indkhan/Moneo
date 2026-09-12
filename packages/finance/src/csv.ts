import { loadLimits, type LimitsConfig } from "@moneo/shared/limits";
import { DomainError } from "@moneo/shared/problem";

/**
 * Issue 3.3 — bounded CSV parser.
 *
 * Deliberately dependency-free and strict: the parser sniffs the delimiter,
 * decodes UTF-8/UTF-16 (BOM-aware), and parses RFC-4180-style quoting with
 * hard bounds on bytes, rows, columns, and cell length. Anything structural
 * (over-bound input, unterminated quotes, empty files) throws
 * VALIDATION_FAILED and the import fails closed; individual rows with the
 * wrong column count are collected as row errors so the workflow (Issue 3.6)
 * can count them in `error_count` while keeping the good rows.
 *
 * Line numbers are PHYSICAL 1-based file lines (the header usually being
 * line 1). Blank lines are skipped but still consume a line number, so an
 * error's `rowNumber` always points at the exact line in the original file
 * and doubles as the observation `row_number` (Issue 3.1).
 */

export type CsvDelimiter = "," | ";" | "\t" | "|";

const CANDIDATES: readonly CsvDelimiter[] = [",", ";", "\t", "|"];

export interface CsvBounds {
  maxBytes: number;
  maxRows: number;
  maxColumns: number;
  maxCellChars: number;
}

export function defaultCsvBounds(limits: LimitsConfig = loadLimits()): CsvBounds {
  return {
    maxBytes: limits.uploadMaxBytes,
    maxRows: limits.uploadMaxRows,
    maxColumns: 100,
    maxCellChars: 32_768,
  };
}

export interface CsvRow {
  /** Physical 1-based file line where the row starts. */
  rowNumber: number;
  cells: string[];
}

export interface CsvRowError {
  rowNumber: number;
  message: string;
}

export interface ParsedCsv {
  delimiter: CsvDelimiter;
  headers: string[];
  /** Well-formed data rows (header and blank lines excluded). */
  rows: CsvRow[];
  /** Rows rejected for column-count mismatch (parse continues). */
  errors: CsvRowError[];
}

function fail(field: string, message: string, detail?: string): never {
  throw new DomainError("VALIDATION_FAILED", {
    detail: detail ?? message,
    errors: [{ field, message }],
  });
}

/**
 * Decode statement bytes. Strips a UTF-8 BOM, transcodes UTF-16 LE/BE via
 * their BOMs, and otherwise decodes UTF-8. Anything else (e.g. Latin-1
 * without a BOM) arrives as replacement characters rather than mojibake
 * crashes — the workflow surfaces the garbled preview and the user
 * re-exports as UTF-8.
 */
export function decodeStatementBytes(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.slice(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.slice(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.slice(2));
  }
  const text = new TextDecoder("utf-8").decode(bytes);
  return text.startsWith("﻿") ? text.slice(1) : text;
}

/** Remove quoted spans so delimiter sniffing counts structure, not content. */
function unquoted(sample: string): string {
  return sample.replace(/"(?:[^"]|"")*"/g, '""');
}

/**
 * Pick the delimiter with the most occurrences across the first lines that
 * also splits those lines MOST consistently (lowest spread of per-line
 * counts wins ties). Falls back to comma for single-column files.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const lines = unquoted(text)
    .split(/\r\n|\n|\r/)
    .filter((l) => l.trim() !== "")
    .slice(0, 5);
  if (lines.length === 0) {
    return ",";
  }
  let best: CsvDelimiter = ",";
  let bestTotal = -1;
  let bestSpread = Number.POSITIVE_INFINITY;
  for (const delimiter of CANDIDATES) {
    const counts = lines.map((line) => line.split(delimiter).length - 1);
    const total = counts.reduce((a, b) => a + b, 0);
    const spread = Math.max(...counts) - Math.min(...counts);
    if (total > bestTotal || (total === bestTotal && spread < bestSpread)) {
      best = delimiter;
      bestTotal = total;
      bestSpread = spread;
    }
  }
  return bestTotal <= 0 ? "," : best;
}

interface RawRecord {
  rowNumber: number;
  cells: string[];
}

/** Split text into records on physical lines, honoring RFC-4180 quoting. */
function splitRecords(
  text: string,
  delimiter: CsvDelimiter,
  bounds: CsvBounds,
): { records: RawRecord[]; totalLines: number } {
  const records: RawRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let recordStartLine = 1;
  let line = 1;
  let cellChars = 0;

  const pushCell = (): void => {
    if (cells.length >= bounds.maxColumns) {
      fail(
        "rows",
        `Row ${recordStartLine} exceeds the ${bounds.maxColumns} column limit.`,
        `Row ${recordStartLine} has more than ${bounds.maxColumns} columns.`,
      );
    }
    cells.push(cell);
    cell = "";
    cellChars = 0;
  };

  const pushChar = (char: string): void => {
    cellChars += 1;
    if (cellChars > bounds.maxCellChars) {
      fail(
        "rows",
        `Row ${recordStartLine} has a cell longer than ${bounds.maxCellChars} characters.`,
      );
    }
    cell += char;
  };

  let i = 0;
  while (i < text.length) {
    const char = text[i] as string;
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          pushChar('"');
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        if (char === "\n") {
          line += 1;
        } else if (char === "\r") {
          // A CR inside quotes still starts a new physical line unless it
          // is half of a CRLF pair (count the pair once).
          if (text[i + 1] !== "\n") {
            line += 1;
          }
        }
        pushChar(char);
        i += 1;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      i += 1;
    } else if (char === delimiter) {
      pushCell();
      i += 1;
    } else if (char === "\r" || char === "\n") {
      pushCell();
      records.push({ rowNumber: recordStartLine, cells });
      if (records.length > bounds.maxRows + 1) {
        // Abort mid-split: a hostile file must not force us to materialize
        // millions of records before the row bound is checked.
        fail("rows", `File has more than ${bounds.maxRows} data rows.`);
      }
      cells = [];
      if (char === "\r" && text[i + 1] === "\n") {
        i += 2;
      } else {
        i += 1;
      }
      line += 1;
      recordStartLine = line;
    } else {
      pushChar(char);
      i += 1;
    }
  }
  if (inQuotes) {
    fail("file", `Unterminated quoted field starting on line ${recordStartLine}.`);
  }
  // Trailing content without a line break is still a record.
  if (cells.length > 0 || cell !== "") {
    pushCell();
    records.push({ rowNumber: recordStartLine, cells });
  }
  return { records, totalLines: line };
}

function isBlank(cells: string[]): boolean {
  return cells.length === 0 || (cells.length === 1 && (cells[0] as string).trim() === "");
}

/** Parse statement text with the given (or detected) delimiter. */
export function parseCsvText(
  text: string,
  options: {
    delimiter?: CsvDelimiter;
    bounds?: CsvBounds;
  } = {},
): ParsedCsv {
  const bounds = options.bounds ?? defaultCsvBounds();
  if (new TextEncoder().encode(text).length > bounds.maxBytes) {
    fail("file", `File exceeds the ${bounds.maxBytes} byte limit.`);
  }
  const delimiter = options.delimiter ?? detectDelimiter(text);
  const { records } = splitRecords(text, delimiter, bounds);

  const content = records.filter((r) => !isBlank(r.cells));
  if (content.length === 0) {
    fail("file", "File has no header row.");
  }
  const [header, ...data] = content;
  const headers = (header as RawRecord).cells;
  if (headers.length > bounds.maxColumns) {
    fail("header", `Header exceeds the ${bounds.maxColumns} column limit.`);
  }
  if (data.length > bounds.maxRows) {
    fail("rows", `File has more than ${bounds.maxRows} data rows.`);
  }

  const rows: CsvRow[] = [];
  const errors: CsvRowError[] = [];
  for (const record of data) {
    if (record.cells.length !== headers.length) {
      errors.push({
        rowNumber: record.rowNumber,
        message: `Expected ${headers.length} columns, found ${record.cells.length}.`,
      });
      continue;
    }
    rows.push({ rowNumber: record.rowNumber, cells: record.cells });
  }
  return { delimiter, headers, rows, errors };
}

/** Decode bytes, then parse. One call covers the whole CSV ingestion path. */
export function parseCsvBytes(
  bytes: Uint8Array,
  options: { delimiter?: CsvDelimiter; bounds?: CsvBounds } = {},
): ParsedCsv {
  const bounds = options.bounds ?? defaultCsvBounds();
  if (bytes.length > bounds.maxBytes) {
    fail("file", `File exceeds the ${bounds.maxBytes} byte limit.`);
  }
  return parseCsvText(decodeStatementBytes(bytes), { ...options, bounds });
}

/** Header + first `previewRows` data rows for the mapping step (Issue 3.5). */
export function previewCsv(
  text: string,
  previewRows = 5,
  options: { delimiter?: CsvDelimiter; bounds?: CsvBounds } = {},
): { delimiter: CsvDelimiter; headers: string[]; preview: CsvRow[]; totalRows: number } {
  const parsed = parseCsvText(text, options);
  return {
    delimiter: parsed.delimiter,
    headers: parsed.headers,
    preview: parsed.rows.slice(0, previewRows),
    totalRows: parsed.rows.length,
  };
}

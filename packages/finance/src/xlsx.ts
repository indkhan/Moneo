import { createInflateRaw } from "node:zlib";
import { loadLimits, type LimitsConfig } from "@moneo/shared/limits";
import { DomainError } from "@moneo/shared/problem";

/**
 * Issue 3.4 — hardened XLSX parser.
 *
 * An .xlsx file is a ZIP of XML parts. This parser reads that ZIP directly
 * (node:zlib only, no spreadsheet dependency) so every trust boundary stays
 * under our control:
 *
 * - ZIP entry count and (declared AND actual) uncompressed sizes are capped
 *   before/while inflating — the classic zip-bomb shape dies here.
 * - Macro/activeX/executable parts are rejected by name, and `vba`/`macro`
 *   content types are rejected by manifest.
 * - Formulas are NEVER executed: a cell with `<f>` resolves to its cached
 *   `<v>` (or empty when uncached) and only increments `formulaCells`.
 * - Nothing is ever fetched: relationship targets with `TargetMode=External`
 *   and `externalLinks` parts are ignored; the module performs no network I/O.
 * - Rows, columns, cell length, and shared-string totals are bounded, and
 *   inflation itself is stream-capped so a lying header cannot force a
 *   gigabyte allocation.
 *
 * Output mirrors the CSV parser (`headers`/`rows`/`errors` with physical
 * spreadsheet row numbers) so the column mapper (Issue 3.5) and the durable
 * workflow (Issue 3.6) treat both formats identically.
 */

export interface XlsxBounds {
  maxBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalUncompressedBytes: number;
  maxRows: number;
  maxColumns: number;
  maxCellChars: number;
  maxTotalStringChars: number;
}

export function defaultXlsxBounds(limits: LimitsConfig = loadLimits()): XlsxBounds {
  return {
    maxBytes: limits.uploadMaxBytes,
    maxEntries: 1000,
    maxEntryBytes: 32 * 1024 * 1024,
    maxTotalUncompressedBytes: 64 * 1024 * 1024,
    maxRows: limits.uploadMaxRows,
    maxColumns: 100,
    maxCellChars: 32_768,
    maxTotalStringChars: 8 * 1024 * 1024,
  };
}

export interface XlsxRow {
  /** Spreadsheet row number (1-based, header usually 1). */
  rowNumber: number;
  cells: string[];
}

export interface XlsxRowError {
  rowNumber: number;
  message: string;
}

export interface ParsedXlsx {
  sheetName: string;
  headers: string[];
  rows: XlsxRow[];
  errors: XlsxRowError[];
  /** Cells seen with a `<f>` formula element (cached values returned, never computed). */
  formulaCells: number;
}

function fail(field: string, message: string): never {
  throw new DomainError("VALIDATION_FAILED", {
    detail: message,
    errors: [{ field, message }],
  });
}

// ---------------------------------------------------------------------------
// Minimal ZIP reader (stored + deflated only).
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  uncompSize: number;
  localOffset: number;
}

/** Parts that must never appear in a statement workbook. */
const FORBIDDEN_NAME_PARTS = [
  ".bin",
  "vbaproject",
  "activex",
  ".vbs",
  ".js",
  ".exe",
  ".dll",
  ".msi",
  "macrosheet",
  "dialogsheet",
];

function checkEntryName(raw: string): string {
  const name = raw.replace(/\\/g, "/");
  if (
    name.startsWith("/") ||
    /^[a-zA-Z]:/.test(name) ||
    name.split("/").some((segment) => segment === "..")
  ) {
    fail("file", `Archive entry "${raw}" escapes the package.`);
  }
  const lowered = name.toLowerCase();
  for (const part of FORBIDDEN_NAME_PARTS) {
    if (lowered.includes(part)) {
      fail("file", `Archive entry "${raw}" looks like executable content and is rejected.`);
    }
  }
  return name;
}

function readZipEntries(bytes: Uint8Array, bounds: XlsxBounds): Map<string, ZipEntry> {
  if (bytes.length < 22) {
    fail("file", "File is not a ZIP archive.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // EOCD is the LAST PK\x05\x06 record (a comment may contain the magic).
  let eocd = -1;
  const scanFrom = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= scanFrom; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    fail("file", "File is not a ZIP archive.");
  }
  const totalEntries = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (totalEntries === 0) {
    fail("file", "ZIP archive has no entries.");
  }
  if (totalEntries > bounds.maxEntries) {
    fail("file", `Archive has ${totalEntries} entries (limit ${bounds.maxEntries}).`);
  }
  if (cdOffset + cdSize > bytes.length) {
    fail("file", "ZIP central directory is truncated.");
  }

  const entries = new Map<string, ZipEntry>();
  let totalUncomp = 0;
  let offset = cdOffset;
  const decoder = new TextDecoder("utf-8");
  for (let n = 0; n < totalEntries; n += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) {
      fail("file", "ZIP central directory is corrupt.");
    }
    const method = view.getUint16(offset + 10, true);
    const compSize = view.getUint32(offset + 20, true);
    const uncompSize = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    if (nameStart + nameLen + extraLen + commentLen > bytes.length) {
      fail("file", "ZIP central directory is truncated.");
    }
    const name = checkEntryName(decoder.decode(bytes.slice(nameStart, nameStart + nameLen)));
    if (method !== 0 && method !== 8) {
      fail("file", `Archive entry "${name}" uses unsupported compression.`);
    }
    if (uncompSize > bounds.maxEntryBytes) {
      fail("file", `Archive entry "${name}" is larger than the entry limit.`);
    }
    totalUncomp += uncompSize;
    if (totalUncomp > bounds.maxTotalUncompressedBytes) {
      fail("file", "Archive uncompressed size exceeds the total limit.");
    }
    if (localOffset >= bytes.length) {
      fail("file", `Archive entry "${name}" points outside the file.`);
    }
    if (!entries.has(name)) {
      entries.set(name, { name, method, compSize, uncompSize, localOffset });
    }
    offset = nameStart + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Inflate with a hard output cap: a lying size header cannot force a huge allocation. */
function inflateCapped(input: Uint8Array, capBytes: number, what: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;
    const stream = createInflateRaw();
    stream.on("data", (chunk: Uint8Array) => {
      total += chunk.length;
      if (total > capBytes) {
        if (!settled) {
          settled = true;
          stream.destroy();
          reject(
            new DomainError("VALIDATION_FAILED", {
              detail: `${what} expands beyond the size limit during decompression.`,
              errors: [{ field: "file", message: "archive entry is too large" }],
            }),
          );
        }
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => {
      if (!settled) {
        settled = true;
        const out = new Uint8Array(total);
        let at = 0;
        for (const chunk of chunks) {
          out.set(chunk, at);
          at += chunk.length;
        }
        resolve(out);
      }
    });
    stream.on("error", (error: unknown) => {
      if (!settled) {
        settled = true;
        reject(
          new DomainError("VALIDATION_FAILED", {
            detail: `${what} is corrupt: ${(error as Error).message}`,
            errors: [{ field: "file", message: "archive entry is corrupt" }],
          }),
        );
      }
    });
    stream.end(input);
  });
}

async function extractEntry(
  bytes: Uint8Array,
  entries: Map<string, ZipEntry>,
  name: string,
  bounds: XlsxBounds,
): Promise<Uint8Array> {
  const entry = entries.get(name);
  if (!entry) {
    fail("file", `Archive is missing required part "${name}".`);
  }
  // `fail` returns never, so `entry` is narrowed to ZipEntry below.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const off = entry.localOffset;
  if (off + 30 > bytes.length || view.getUint32(off, true) !== 0x04034b50) {
    fail("file", `Archive entry "${name}" has a corrupt local header.`);
  }
  if (view.getUint16(off + 8, true) !== entry.method) {
    fail("file", `Archive entry "${name}" disagrees with its directory record.`);
  }
  const dataStart = off + 30 + view.getUint16(off + 26, true) + view.getUint16(off + 28, true);
  if (dataStart + entry.compSize > bytes.length) {
    fail("file", `Archive entry "${name}" is truncated.`);
  }
  const comp = bytes.slice(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) {
    if (comp.length !== entry.uncompSize) {
      fail("file", `Archive entry "${name}" has inconsistent sizes.`);
    }
    return comp;
  }
  const cap = Math.min(entry.uncompSize, bounds.maxEntryBytes);
  return inflateCapped(comp, cap, `Archive entry "${name}"`);
}

// ---------------------------------------------------------------------------
// Minimal XML extraction (no DOM, no entity expansion attacks).
// ---------------------------------------------------------------------------

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&(lt|gt|amp|quot|apos);/g, (_match, name: string) => {
      switch (name) {
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "amp":
          return "&";
        case "quot":
          return '"';
        default:
          return "'";
      }
    })
    .replace(/&#(\d+);/g, (_match, digits: string) => {
      try {
        return String.fromCodePoint(Number.parseInt(digits, 10));
      } catch {
        return "�";
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, digits: string) => {
      try {
        return String.fromCodePoint(Number.parseInt(digits, 16));
      } catch {
        return "�";
      }
    });
}

function attr(tag: string, name: string): string | null {
  const match = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return match?.[1] ?? null;
}

/** Relationship id -> internal target. External targets are dropped (never fetched). */
function parseRels(xml: string): Map<string, string> {
  const rels = new Map<string, string>();
  for (const match of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = match[0];
    const id = attr(tag, "Id");
    const target = attr(tag, "Target");
    if (!id || !target) {
      continue;
    }
    if (/TargetMode="External"/.test(tag) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) {
      continue;
    }
    rels.set(id, target.replace(/^\/+/, ""));
  }
  return rels;
}

function resolveSheetTarget(target: string): string {
  const clean = target.replace(/^\/+/, "");
  return clean.startsWith("xl/") ? clean : `xl/${clean}`;
}

/** Ordered sheets: [{ name, file }]. Falls back to sheetN.xml when rels are absent. */
function parseWorkbook(
  xml: string,
  rels: Map<string, string>,
): Array<{ name: string; file: string }> {
  const sheets: Array<{ name: string; file: string }> = [];
  let order = 0;
  for (const match of xml.matchAll(/<sheet\b[^>]*>/g)) {
    order += 1;
    const tag = match[0];
    const name = attr(tag, "name") ?? `Sheet${order}`;
    const ridMatch = /r:id="([^"]*)"/.exec(tag);
    const rid = ridMatch?.[1] ?? null;
    const target = rid ? rels.get(rid) : undefined;
    sheets.push({
      name,
      file: target ? resolveSheetTarget(target) : `xl/worksheets/sheet${order}.xml`,
    });
  }
  if (sheets.length === 0) {
    fail("file", "Workbook has no sheets.");
  }
  return sheets;
}

/** Shared strings in index order, with a cap on total characters. */
function parseSharedStrings(xml: string, bounds: XlsxBounds): string[] {
  const strings: string[] = [];
  let totalChars = 0;
  for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const body = si[1] ?? "";
    let text = "";
    for (const t of body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) {
      text += decodeXmlEntities(t[1] ?? "");
    }
    totalChars += text.length;
    if (totalChars > bounds.maxTotalStringChars) {
      fail("file", "Shared-string content exceeds the text limit.");
    }
    strings.push(text);
  }
  return strings;
}

function columnToIndex(letters: string): number {
  let index = 0;
  for (const char of letters) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

function parseSheetRow(
  rowXml: string,
  sst: string[],
  field: string,
): { cells: Map<number, string>; formulas: number } {
  const cells = new Map<number, string>();
  let formulas = 0;
  // Self-closing (empty) cells carry no value but still occupy their column.
  for (const match of rowXml.matchAll(/<c\b[^>]*\/>/g)) {
    const colMatch = /^<c\b[^>]*r="([A-Z]+)\d+"/.exec(match[0]);
    if (colMatch) {
      cells.set(columnToIndex(colMatch[1] ?? ""), "");
    }
  }
  for (const match of rowXml.matchAll(/<c\b[^>]*>([\s\S]*?)<\/c>/g)) {
    const full = match[0];
    const body = match[1] ?? "";
    const openTag = /^<c\b[^>]*>/.exec(full)?.[0] ?? "<c>";
    const ref = attr(openTag, "r");
    const colLetters = ref ? /^[A-Z]+/.exec(ref)?.[0] : null;
    if (!colLetters) {
      continue;
    }
    const type = attr(openTag, "t") ?? "n";
    const hasFormula = /<f[\s>]/.test(body);
    if (hasFormula) {
      formulas += 1;
    }
    const vMatch = /<v>([\s\S]*?)<\/v>/.exec(body);
    const vText = vMatch ? decodeXmlEntities(vMatch[1] ?? "") : "";
    let text: string;
    if (type === "s") {
      const index = Number.parseInt(vText, 10);
      if (!Number.isInteger(index) || index < 0 || index >= sst.length) {
        fail(field, "Shared-string reference is out of range.");
      }
      text = sst[index] ?? "";
    } else if (type === "inlineStr") {
      const tMatch = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(body);
      text = tMatch ? decodeXmlEntities(tMatch[1] ?? "") : "";
    } else if (type === "str") {
      text = vText;
    } else if (type === "b") {
      text = vText === "1" ? "TRUE" : vText === "0" ? "FALSE" : vText;
    } else if (type === "e") {
      text = "";
    } else {
      // Numeric (dates arrive as serials; the mapper interprets them).
      text = vText;
    }
    // A formula with no cached value contributes an empty cell, never an
    // evaluation. The cached `<v>` above is returned verbatim otherwise —
    // even when it is stale — which is exactly the non-execution guarantee.
    if (hasFormula && !vMatch && type !== "inlineStr") {
      text = "";
    }
    cells.set(columnToIndex(colLetters), text);
  }
  return { cells, formulas };
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * Parse the FIRST sheet of a statement workbook. The manifest is scanned for
 * macro content types before any sheet XML is trusted.
 */
export async function parseXlsxBytes(
  bytes: Uint8Array,
  options: { bounds?: XlsxBounds } = {},
): Promise<ParsedXlsx> {
  const bounds = options.bounds ?? defaultXlsxBounds();
  if (bytes.length > bounds.maxBytes) {
    fail("file", `File exceeds the ${bounds.maxBytes} byte limit.`);
  }
  const entries = readZipEntries(bytes, bounds);

  const contentTypes = entries.get("[Content_Types].xml");
  if (!contentTypes) {
    fail("file", "File is not a spreadsheet.");
  }
  const manifest = new TextDecoder("utf-8").decode(
    await extractEntry(bytes, entries, "[Content_Types].xml", bounds),
  );
  const loweredManifest = manifest.toLowerCase();
  if (loweredManifest.includes("vba") || loweredManifest.includes("macro")) {
    fail("file", "Macro-enabled workbooks are rejected.");
  }
  if (!entries.has("xl/workbook.xml")) {
    fail("file", "File is not a spreadsheet.");
  }

  const decoder = new TextDecoder("utf-8");
  const workbookXml = decoder.decode(await extractEntry(bytes, entries, "xl/workbook.xml", bounds));
  const relsEntry = entries.get("xl/_rels/workbook.xml.rels");
  const rels = relsEntry
    ? parseRels(
        decoder.decode(await extractEntry(bytes, entries, "xl/_rels/workbook.xml.rels", bounds)),
      )
    : new Map<string, string>();
  const sheets = parseWorkbook(workbookXml, rels);
  const first = sheets[0];
  if (!first) {
    fail("file", "Workbook has no sheets.");
  }
  if (!entries.has(first.file)) {
    fail("file", `Sheet part "${first.file}" is missing.`);
  }

  const sstEntry = entries.get("xl/sharedStrings.xml");
  const sst = sstEntry
    ? parseSharedStrings(
        decoder.decode(await extractEntry(bytes, entries, "xl/sharedStrings.xml", bounds)),
        bounds,
      )
    : [];

  const sheetXml = decoder.decode(await extractEntry(bytes, entries, first.file, bounds));
  const rows: XlsxRow[] = [];
  const errors: XlsxRowError[] = [];
  let headers: string[] | null = null;
  let formulaCells = 0;
  let dataRows = 0;
  let autoRow = 0;

  for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowTag = /^<row\b[^>]*>/.exec(rowMatch[0])?.[0] ?? "<row>";
    const rAttr = attr(rowTag, "r");
    const rowNumber = rAttr ? Number.parseInt(rAttr, 10) : (autoRow += 1);
    if (!Number.isInteger(rowNumber) || rowNumber <= 0) {
      continue;
    }
    autoRow = Math.max(autoRow, rowNumber);
    const { cells: sparse, formulas } = parseSheetRow(rowMatch[1] ?? "", sst, "file");
    formulaCells += formulas;
    if (sparse.size === 0) {
      continue;
    }
    const maxCol = Math.max(...sparse.keys());
    if (maxCol + 1 > bounds.maxColumns) {
      fail("rows", `Row ${rowNumber} exceeds the ${bounds.maxColumns} column limit.`);
    }
    const cells: string[] = [];
    for (let col = 0; col <= maxCol; col += 1) {
      const text = sparse.get(col) ?? "";
      if (text.length > bounds.maxCellChars) {
        fail("rows", `Row ${rowNumber} has a cell longer than ${bounds.maxCellChars} characters.`);
      }
      cells.push(text);
    }
    if (cells.every((c) => c.trim() === "")) {
      continue;
    }
    if (headers === null) {
      headers = cells;
      continue;
    }
    dataRows += 1;
    if (dataRows > bounds.maxRows) {
      fail("rows", `Sheet has more than ${bounds.maxRows} data rows.`);
    }
    if (cells.length !== headers.length) {
      errors.push({
        rowNumber,
        message: `Expected ${headers.length} columns, found ${cells.length}.`,
      });
      continue;
    }
    rows.push({ rowNumber, cells });
  }

  if (headers === null) {
    fail("file", "Sheet has no header row.");
  }
  return { sheetName: first.name, headers, rows, errors, formulaCells };
}

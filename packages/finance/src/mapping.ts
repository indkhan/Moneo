import { isKnownCurrency, minorDigitsFor } from "@moneo/shared/currencies";
import { toMinorUnits } from "@moneo/shared/money";
import { DomainError } from "@moneo/shared/problem";

/**
 * Issue 3.5 — statement column mapping.
 *
 * Parsers (Issues 3.3/3.4) produce untyped string grids; this module maps
 * grid columns onto the six statement fields the workflow needs:
 *
 *   date · description · amount · currency · direction/credit/debit · account
 *
 * Amounts arrive in one of two shapes: a SINGLE amount column (sign or a
 * direction column decides credit/debit) or a CREDIT+DEBIT column pair.
 * The mapping holds `amount` XOR (`credit` AND `debit`); validation rejects
 * anything else.
 *
 * Three entry points, in wizard order: `detectColumnMapping` (header
 * synonyms, EN+DE), `resolveMapping` (auto result plus manual overrides,
 * then validation), and `previewMappedRows` (typed preview with per-row
 * errors, never a throw for bad data). Money stays exact throughout: the
 * shared minor-unit converter is the only numeric path, so `parseFloat`
 * never appears here.
 */

export type MappedField =
  "date" | "description" | "amount" | "credit" | "debit" | "currency" | "direction" | "account";

export interface ColumnMapping {
  date: number | null;
  description: number | null;
  amount: number | null;
  credit: number | null;
  debit: number | null;
  currency: number | null;
  direction: number | null;
  account: number | null;
}

export type MappingConfidence = "exact" | "partial" | "none";

export interface DetectedMapping {
  mapping: ColumnMapping;
  confidence: Record<MappedField, MappingConfidence>;
  /** Header indexes no field claimed (candidates for description/account). */
  unmapped: number[];
}

const FIELD_ORDER: readonly MappedField[] = [
  "date",
  "amount",
  "credit",
  "debit",
  "currency",
  "direction",
  "account",
  "description",
];

const SYNONYMS: Record<MappedField, readonly string[]> = {
  date: [
    "date",
    "bookingdate",
    "transactiondate",
    "valuedate",
    "postingdate",
    "datum",
    "buchungstag",
    "buchung",
    "valuta",
    "wertstellung",
    "posted",
  ],
  amount: ["amount", "betrag", "value", "umsatz", "summe"],
  credit: ["credit", "haben", "gutschrift", "eingang", "zufluss", "einnahmen"],
  debit: ["debit", "soll", "lastschrift", "ausgang", "belastung", "ausgaben"],
  currency: ["currency", "ccy", "wahrung", "waehrung"],
  // NB: bare "type"/"typ" is deliberately absent: in Revolut-style files it
  // names a product event (TOPUP, TRANSFER), not a credit/debit marker, and
  // claiming it would turn every row into a direction error at preview.
  direction: ["direction", "sollhaben", "dc", "seite", "vorzeichen"],
  account: [
    "account",
    "konto",
    "iban",
    "accountnumber",
    "kontonummer",
    "wallet",
    "kontobezeichnung",
  ],
  description: [
    "description",
    "memo",
    "details",
    "transactiondetails",
    "verwendungszweck",
    "buchungstext",
    "auftraggeber",
    "empfanger",
    "payee",
    "merchant",
    "reference",
    "referenz",
    "name",
  ],
};

/** Lowercase, de-umlaut/diacritic-folded, alphanumeric only. */
export function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/ä/g, "a")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function matchStrength(normalized: string, synonym: string): 3 | 2 | 1 | 0 {
  if (normalized === synonym) {
    return 3;
  }
  if (normalized.startsWith(synonym) || normalized.endsWith(synonym)) {
    return 2;
  }
  if (normalized.includes(synonym)) {
    return 1;
  }
  return 0;
}

/** Auto-map headers to fields. Each column is claimed at most once. */
export function detectColumnMapping(headers: string[]): DetectedMapping {
  const normalized = headers.map(normalizeHeader);
  const mapping: ColumnMapping = {
    date: null,
    description: null,
    amount: null,
    credit: null,
    debit: null,
    currency: null,
    direction: null,
    account: null,
  };
  const confidence: Record<MappedField, MappingConfidence> = {
    date: "none",
    description: "none",
    amount: "none",
    credit: "none",
    debit: "none",
    currency: "none",
    direction: "none",
    account: "none",
  };
  const claimed = new Set<number>();
  // A header naming BOTH sides ("Soll/Haben", "Credit/Debit") is one
  // direction column, not a credit column that happens to mention debit.
  const combined = normalized.map(
    (text) =>
      (text.includes("soll") && text.includes("haben")) ||
      (text.includes("credit") && text.includes("debit")),
  );

  for (const field of FIELD_ORDER) {
    let bestCol = -1;
    let bestScore = 0;
    headers.forEach((_header, col) => {
      if (claimed.has(col)) {
        return;
      }
      if ((field === "credit" || field === "debit") && combined[col]) {
        return;
      }
      const text = normalized[col] ?? "";
      if (text === "") {
        return;
      }
      for (const synonym of SYNONYMS[field]) {
        const strength = matchStrength(text, synonym);
        if (strength > bestScore) {
          bestScore = strength;
          bestCol = col;
        }
      }
    });
    if (bestCol >= 0 && bestScore > 0) {
      mapping[field] = bestCol;
      claimed.add(bestCol);
      confidence[field] = bestScore === 3 ? "exact" : "partial";
    }
  }
  return {
    mapping,
    confidence,
    unmapped: headers.map((_h, i) => i).filter((i) => !claimed.has(i)),
  };
}

function failMapping(message: string): never {
  throw new DomainError("VALIDATION_FAILED", {
    detail: message,
    errors: [{ field: "mapping", message }],
  });
}

/** Structural validation shared by auto and manual mappings. */
export function validateMapping(headers: string[], mapping: ColumnMapping): void {
  const seen = new Map<number, MappedField>();
  (Object.keys(mapping) as MappedField[]).forEach((field) => {
    const col = mapping[field];
    if (col === null) {
      return;
    }
    if (!Number.isInteger(col) || col < 0 || col >= headers.length) {
      failMapping(`Mapping for ${field} points outside the ${headers.length} columns.`);
    }
    const clash = seen.get(col);
    if (clash !== undefined) {
      failMapping(`Columns for ${clash} and ${field} both point at column ${col}.`);
    }
    seen.set(col, field);
  });
  const hasAmount = mapping.amount !== null;
  const hasSplit = mapping.credit !== null || mapping.debit !== null;
  if (hasAmount && hasSplit) {
    failMapping("Map either a single amount column or a credit/debit pair, not both.");
  }
  if (!hasAmount && !hasSplit) {
    failMapping("An amount column (or a credit/debit pair) is required.");
  }
  if (mapping.date === null) {
    failMapping("A date column is required.");
  }
  if (!hasAmount && (mapping.credit === null || mapping.debit === null)) {
    failMapping("Credit and debit columns are only valid as a pair.");
  }
}

/**
 * Manual fallback: layer caller overrides over auto-detection, then
 * validate. `manual` may set fields to a column index or back to null.
 * Returns the plain mapping (pair with `detectColumnMapping` when the
 * wizard also wants confidences and unmapped hints).
 */
export function resolveMapping(
  headers: string[],
  manual: Partial<Record<MappedField, number | null>> = {},
): ColumnMapping {
  const detected = detectColumnMapping(headers);
  const mapping: ColumnMapping = { ...detected.mapping };
  (Object.keys(manual) as MappedField[]).forEach((field) => {
    const value = manual[field];
    if (value !== undefined) {
      mapping[field] = value;
    }
  });
  validateMapping(headers, mapping);
  return mapping;
}

export type MoneyDirection = "credit" | "debit";

/** Excel serial day (days since 1899-12-30) to ISO date. */
function serialToISO(serial: number): string | null {
  if (!Number.isInteger(serial) || serial < 20_000 || serial > 80_000) {
    return null;
  }
  const millis = Date.UTC(1899, 11, 30) + serial * 86_400_000;
  return new Date(millis).toISOString().slice(0, 10);
}

/**
 * Statement dates in the wild: ISO, German dots, US/EU slashes, and Excel
 * serials from .xlsx numeric cells. Returns an ISO `YYYY-MM-DD` date.
 * Slash pairs are read MM/DD unless the first component exceeds 12.
 */
export function parseStatementDate(raw: string): string {
  const text = raw.trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) {
    const iso = `${match[1]}-${match[2]}-${match[3]}`;
    if (Number.isNaN(Date.parse(`${iso}T00:00:00Z`))) {
      throw new Error(`Invalid ISO date: ${raw}`);
    }
    return iso;
  }
  match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text);
  if (match) {
    const iso = `${match[3]}-${match[2]?.padStart(2, "0")}-${match[1]?.padStart(2, "0")}`;
    if (Number.isNaN(Date.parse(`${iso}T00:00:00Z`))) {
      throw new Error(`Invalid date: ${raw}`);
    }
    return iso;
  }
  match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (match) {
    const first = Number.parseInt(match[1] as string, 10);
    const second = match[2] as string;
    const [month, day] = first > 12 ? [second, match[1] as string] : [match[1] as string, second];
    const iso = `${match[3]}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    if (Number.isNaN(Date.parse(`${iso}T00:00:00Z`))) {
      throw new Error(`Invalid date: ${raw}`);
    }
    return iso;
  }
  if (/^-?\d+(\.0+)?$/.test(text)) {
    const serial = serialToISO(Math.trunc(Number.parseFloat(text)));
    if (serial !== null) {
      return serial;
    }
  }
  throw new Error(`Unrecognized date: ${raw}`);
}

const CREDIT_TOKENS = new Set([
  "credit",
  "c",
  "cr",
  "haben",
  "h",
  "eingang",
  "zufluss",
  "gutschrift",
  "einnahme",
  "+",
]);
const DEBIT_TOKENS = new Set([
  "debit",
  "d",
  "dr",
  "soll",
  "s",
  "lastschrift",
  "ausgang",
  "belastung",
  "ausgabe",
  "-",
]);

/** Explicit direction tokens (direction column). Unknown tokens throw. */
export function parseDirectionToken(raw: string): MoneyDirection {
  const token = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z+-]/g, "");
  if (CREDIT_TOKENS.has(token)) {
    return "credit";
  }
  if (DEBIT_TOKENS.has(token)) {
    return "debit";
  }
  throw new Error(`Unknown direction: ${raw}`);
}

/**
 * Parse a localized amount into non-negative minor units plus an explicit
 * direction. Last separator wins as the decimal mark (`1.234,56` and
 * `1,234.56` both work); parentheses or a leading minus mean debit; the
 * result never carries a sign — direction does that job (Issue 0.9 rule).
 */
export function parseStatementAmount(
  raw: string,
  currency: string,
): { amountMinor: bigint; direction: MoneyDirection } {
  const minorDigits = minorDigitsFor(currency);
  let text = raw.trim();
  if (text === "") {
    throw new Error("Empty amount");
  }
  let direction: MoneyDirection = "credit";
  if (text.startsWith("(") && text.endsWith(")")) {
    direction = "debit";
    text = text.slice(1, -1).trim();
  }
  if (text.startsWith("-") || text.startsWith("−")) {
    direction = "debit";
    text = text.slice(1).trim();
  } else if (text.startsWith("+")) {
    text = text.slice(1).trim();
  }
  // Strip spaces, apostrophes, and currency decorations; keep digits + seps.
  text = text.replace(/[\s']/g, "").replace(/[^0-9.,]/g, "");
  if (text === "" || !/\d/.test(text)) {
    throw new Error(`Unrecognized amount: ${raw}`);
  }
  // Whole-unit suffix: zero-exponent currencies take bare digits ("1500"
  // JPY); every other currency takes an explicit fraction ("1500.00").
  const whole = (digits: string): string =>
    minorDigits === 0 ? digits : `${digits}.${"0".repeat(minorDigits)}`;
  const digitsOnly = text.replace(/[.,]/g, "");
  const lastDot = text.lastIndexOf(".");
  const lastComma = text.lastIndexOf(",");
  let canonical: string;
  if (lastDot >= 0 && lastComma >= 0) {
    // Both kinds present: the last one is the decimal mark
    // ("1.234,56" and "1,234.56" agree on 1234.56).
    const decimalAt = Math.max(lastDot, lastComma);
    canonical = `${text.slice(0, decimalAt).replace(/[.,]/g, "")}.${text.slice(decimalAt + 1)}`;
  } else {
    const seps = text.match(/[.,]/g) ?? [];
    const sepAt = Math.max(lastDot, lastComma);
    if (seps.length === 0) {
      canonical = whole(digitsOnly);
    } else if (seps.length >= 2) {
      // Repeated separators are grouping ("1,234,567"); a ragged tail
      // ("12.50.00") is malformed and fails closed, never guessed.
      const trailing = text.slice(sepAt + 1);
      if (trailing.length !== 3) {
        throw new Error(`Unrecognized amount: ${raw}`);
      }
      canonical = whole(digitsOnly);
    } else if (text.length - sepAt - 1 === 3) {
      // One separator + exactly three trailing digits is grouping
      // ("1,234" → 1234). This never misparses a valid 0–2 digit decimal
      // (three fraction digits would exceed their precision anyway);
      // 3-exponent currencies accept the documented ambiguity here.
      canonical = whole(digitsOnly);
    } else {
      canonical = `${text.slice(0, sepAt).replace(/[.,]/g, "")}.${text.slice(sepAt + 1)}`;
    }
  }
  const amountMinor = toMinorUnits(canonical, minorDigits);
  const abs = amountMinor < 0n ? -amountMinor : amountMinor;
  return { amountMinor: abs, direction: abs === 0n ? "credit" : direction };
}

export interface MappedPreviewRow {
  rowNumber: number;
  date: string;
  description: string;
  /** Non-negative integer minor units as a decimal string (exact JSON). */
  amountMinor: string;
  currency: string;
  direction: MoneyDirection;
  account: string | null;
}

export interface MappedRowError {
  rowNumber: number;
  message: string;
}

function cellOf(cells: string[], col: number | null): string {
  if (col === null) {
    return "";
  }
  return (cells[col] ?? "").trim();
}

/**
 * Typed preview of mapped rows. Bad DATA becomes `errors` entries (the
 * import summary counts them); only a bad MAPPING throws. `defaultCurrency`
 * fills rows whose file has no currency column (chosen in the wizard).
 */
export function previewMappedRows(args: {
  headers: string[];
  rows: Array<{ rowNumber: number; cells: string[] }>;
  mapping: ColumnMapping;
  defaultCurrency?: string;
  previewRows?: number;
}): { preview: MappedPreviewRow[]; errors: MappedRowError[]; totalRows: number } {
  validateMapping(args.headers, args.mapping);
  const defaultCurrency = (args.defaultCurrency ?? "EUR").toUpperCase();
  if (!isKnownCurrency(defaultCurrency)) {
    failMapping(`Unknown default currency: ${defaultCurrency}.`);
  }
  const preview: MappedPreviewRow[] = [];
  const errors: MappedRowError[] = [];
  const limit = args.previewRows ?? 5;

  for (const row of args.rows) {
    try {
      const date = parseStatementDate(cellOf(row.cells, args.mapping.date));
      const description = cellOf(row.cells, args.mapping.description);

      // Currency first: the amount is parsed once against the row's own
      // exponent (a JPY row inside a EUR-default file keeps JPY precision).
      let currency = defaultCurrency;
      const currencyRaw = cellOf(row.cells, args.mapping.currency);
      if (currencyRaw !== "") {
        currency = currencyRaw.toUpperCase();
        if (!isKnownCurrency(currency)) {
          throw new Error(`Unknown currency: ${currencyRaw}.`);
        }
      }

      let amountMinor: bigint;
      let direction: MoneyDirection;
      if (args.mapping.amount !== null) {
        const parsed = parseStatementAmount(cellOf(row.cells, args.mapping.amount), currency);
        amountMinor = parsed.amountMinor;
        direction = parsed.direction;
        // An explicit direction column overrides the sign-derived one.
        const token = cellOf(row.cells, args.mapping.direction);
        if (token !== "") {
          direction = parseDirectionToken(token);
        }
      } else {
        const creditRaw = cellOf(row.cells, args.mapping.credit);
        const debitRaw = cellOf(row.cells, args.mapping.debit);
        if ((creditRaw === "") === (debitRaw === "")) {
          throw new Error("Expected exactly one of the credit/debit columns to be filled.");
        }
        if (creditRaw !== "") {
          amountMinor = parseStatementAmount(creditRaw, currency).amountMinor;
          direction = "credit";
        } else {
          amountMinor = parseStatementAmount(debitRaw, currency).amountMinor;
          direction = "debit";
        }
      }

      const accountRaw = cellOf(row.cells, args.mapping.account);
      preview.push({
        rowNumber: row.rowNumber,
        date,
        description,
        amountMinor: amountMinor.toString(),
        currency,
        direction,
        account: accountRaw === "" ? null : accountRaw,
      });
      if (preview.length >= limit) {
        break;
      }
    } catch (error) {
      errors.push({ rowNumber: row.rowNumber, message: (error as Error).message });
    }
  }
  return { preview, errors, totalRows: args.rows.length };
}

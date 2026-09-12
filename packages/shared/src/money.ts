/**
 * Exact-money foundation (Issue 0.9). Authoritative monetary values are
 * integer minor units plus an ISO 4217 currency code. Floating point is
 * never authoritative. This module is the single canonical copy; Issue 4.4
 * is an integration check, not a second implementation.
 */
import { z } from "zod";
import { minorDigitsFor } from "./currencies.js";

export function toMinorUnits(amountMajor: string, minorDigits: number): bigint {
  const trimmed = amountMajor.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid decimal amount: ${amountMajor}`);
  }
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [wholeRaw, fraction = ""] = unsigned.split(".");
  const whole = wholeRaw ?? "";
  if (fraction.length > minorDigits) {
    throw new Error(`Amount ${amountMajor} exceeds minor-unit precision (${minorDigits})`);
  }
  const padded = fraction.padEnd(minorDigits, "0");
  const minor = BigInt(`${whole === "" ? "0" : whole}${padded === "" ? "" : padded}`);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Amount exceeds safe integer range");
  }
  return negative ? -minor : minor;
}

export function fromMinorUnits(minorUnits: bigint | number, minorDigits: number): string {
  const value = typeof minorUnits === "number" ? BigInt(minorUnits) : minorUnits;
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const divisor = 10n ** BigInt(minorDigits);
  const whole = abs / divisor;
  const fraction = (abs % divisor).toString().padStart(minorDigits, "0");
  const out = minorDigits === 0 ? whole.toString() : `${whole.toString()}.${fraction}`;
  return negative ? `-${out}` : out;
}

export function assertSafeInteger(value: bigint | number, label = "amount"): void {
  const n = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds safe integer range`);
  }
}

/** Explicit money direction. Negative input never survives as a signed amount. */
export type Direction = "credit" | "debit";

/**
 * Canonical in-memory money value: non-negative integer minor units plus an
 * explicit direction. Zero is always canonicalized to `credit`.
 */
export interface Money {
  amountMinor: bigint;
  currency: string;
  direction: Direction;
}

export type MoneyLocale = "en-US" | "en-GB" | "de-DE" | "nl-NL" | "it-IT" | "es-ES" | "fr-FR";

interface Separators {
  group: string;
  decimal: string;
}

const SEPARATORS: Record<MoneyLocale, Separators> = {
  "en-US": { group: ",", decimal: "." },
  "en-GB": { group: ",", decimal: "." },
  "de-DE": { group: ".", decimal: "," },
  "nl-NL": { group: ".", decimal: "," },
  "it-IT": { group: ".", decimal: "," },
  "es-ES": { group: ".", decimal: "," },
  "fr-FR": { group: "\u202f", decimal: "," },
};

const MINUS_SIGNS = new Set(["-", "−"]);
const GROUP_SPACE_EQUIVALENTS = new Set(["\u0020", "\u00A0", "\u202F"]);

function escapeRegExp(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripGroupSeparators(wholeRaw: string, group: string): string {
  const chars = [group, ...GROUP_SPACE_EQUIVALENTS].map(escapeRegExp).join("");
  return wholeRaw.replace(new RegExp(`[${chars}]`, "g"), "");
}

function groupWholeDigits(whole: string, group: string): string {
  if (whole.length <= 3) return whole;
  const parts: string[] = [];
  let rest = whole;
  while (rest.length > 3) {
    parts.unshift(rest.slice(-3));
    rest = rest.slice(0, -3);
  }
  parts.unshift(rest);
  return parts.join(group);
}

function splitLocalized(raw: string, separators: Separators): { whole: string; fraction: string } {
  const decimalCount = raw.split(separators.decimal).length - 1;
  if (decimalCount > 1) {
    throw new Error(`Invalid amount: multiple decimal separators in ${raw}`);
  }
  const [wholeRaw = "", fraction = ""] = raw.split(separators.decimal);
  if (!/^\d+$/.test(fraction) && fraction !== "") {
    throw new Error(`Invalid amount: bad fraction in ${raw}`);
  }
  const whole = stripGroupSeparators(wholeRaw, separators.group);
  if (whole === "" || !/^\d+$/.test(whole)) {
    throw new Error(`Invalid amount: bad whole part in ${raw}`);
  }
  if (wholeRaw !== "" && wholeRaw.includes(separators.group)) {
    const groups = wholeRaw.split(separators.group);
    const [first, ...rest] = groups;
    if (first === undefined || !/^\d{1,3}$/.test(first) || rest.some((g) => !/^\d{3}$/.test(g))) {
      throw new Error(`Invalid amount: malformed grouping in ${raw}`);
    }
  }
  return { whole, fraction };
}

/**
 * Parse a localized decimal amount string into canonical `Money`.
 *
 * - `locale` selects grouping/decimal separators explicitly (no float path).
 * - A leading `-`/`−`/`+`, or surrounding parentheses `(…)`, maps to an
 *   explicit `direction`; `amountMinor` is always non-negative.
 * - An optional leading/trailing token equal to the currency code is accepted
 *   and stripped; currency symbols are rejected as ambiguous.
 * - Fraction digits beyond the currency exponent are rejected, never rounded.
 * - Values beyond the safe integer range are rejected, never clamped.
 */
export function parseLocalizedAmount(
  input: string,
  options: { currency: string; locale: MoneyLocale },
): Money {
  const { currency, locale } = options;
  const minorDigits = minorDigitsFor(currency);
  const separators = SEPARATORS[locale];

  let text = input.trim();
  if (text === "") throw new Error("Invalid amount: empty input");

  let direction: Direction = "credit";
  const parenthesized = text.startsWith("(") && text.endsWith(")");
  if (parenthesized) {
    direction = "debit";
    text = text.slice(1, -1).trim();
  } else {
    const first = text[0];
    if (first !== undefined && MINUS_SIGNS.has(first)) {
      direction = "debit";
      text = text.slice(1).trim();
    } else if (first === "+") {
      text = text.slice(1).trim();
    }
  }

  const codePattern = new RegExp(`^${currency}\\s+|\\s+${currency}$`, "i");
  text = text.replace(codePattern, "").trim();
  // Stripping the code may expose a second sign layer, e.g. "EUR -12,00".
  if (!parenthesized) {
    const first = text[0];
    if (first !== undefined && MINUS_SIGNS.has(first)) {
      direction = "debit";
      text = text.slice(1).trim();
    } else if (first === "+") {
      text = text.slice(1).trim();
    }
  }

  const { whole, fraction } = splitLocalized(text, separators);
  if (fraction.length > minorDigits) {
    throw new Error(
      `Amount ${input} exceeds minor-unit precision (${minorDigits}) for ${currency}`,
    );
  }
  const amountMinor = BigInt(`${whole}${fraction.padEnd(minorDigits, "0")}`);
  assertSafeInteger(amountMinor, "amount");

  return {
    amountMinor,
    currency,
    // Zero has no direction; canonicalize it so downstream code never
    // branches on a meaningless debit-zero.
    direction: amountMinor === 0n ? "credit" : direction,
  };
}

/**
 * Format canonical `Money` as `[sign]grouped[decimal fraction] CODE`, e.g.
 * `-1,234.56 EUR` (en-US) or `-1.234,56 EUR` (de-DE). Deterministic: no
 * runtime ICU formatting, no floating point.
 */
export function formatMoney(money: Money, locale: MoneyLocale): string {
  const minorDigits = minorDigitsFor(money.currency);
  const separators = SEPARATORS[locale];
  const divisor = 10n ** BigInt(minorDigits);
  const whole = (money.amountMinor / divisor).toString();
  const fraction = (money.amountMinor % divisor).toString().padStart(minorDigits, "0");
  const grouped = groupWholeDigits(whole, separators.group);
  const major = minorDigits === 0 ? grouped : `${grouped}${separators.decimal}${fraction}`;
  const sign = money.direction === "debit" && money.amountMinor !== 0n ? "-" : "";
  return `${sign}${major} ${money.currency}`;
}

const moneyJsonSchema = z.object({
  amount: z.string().regex(/^(0|[1-9]\d*)$/, "amount must be a non-negative integer string"),
  currency: z.string().regex(/^[A-Z]{3}$/, "currency must be an ISO 4217 code"),
  direction: z.enum(["credit", "debit"]),
});

export type MoneyJson = z.infer<typeof moneyJsonSchema>;

/**
 * Exact JSON serialization: minor units travel as a decimal string, never a
 * JSON number, so no precision is lost through `JSON.stringify`.
 */
export function moneyToJSON(money: Money): MoneyJson {
  return {
    amount: money.amountMinor.toString(),
    currency: money.currency,
    direction: money.direction,
  };
}

export function moneyFromJSON(value: unknown): Money {
  const parsed = moneyJsonSchema.parse(value);
  const amountMinor = BigInt(parsed.amount);
  assertSafeInteger(amountMinor, "amount");
  // Rejects unknown currency codes via the canonical dataset.
  minorDigitsFor(parsed.currency);
  return { amountMinor, currency: parsed.currency, direction: parsed.direction };
}

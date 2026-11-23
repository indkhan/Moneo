import { minorDigits } from "./fx";

function exactMinor(value: bigint | string | number): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("Unsafe minor amount");
  return BigInt(value);
}

function moneyFormats(locale: string) {
  return {
    locale,
    integer: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
    decimal: new Intl.NumberFormat(locale).formatToParts(1.1).find(part => part.type === "decimal")?.value ?? ".",
    fractions: new Map<number, Intl.NumberFormat>(),
  };
}

let lastMoneyFormats: ReturnType<typeof moneyFormats> | undefined;

export function formatMoney(amountMinor: bigint | string | number, currencyCode: string, locale?: string): string {
  const value = exactMinor(amountMinor);
  const abs = value < 0n ? -value : value;
  const digits = minorDigits(currencyCode);
  const divisor = 10n ** BigInt(digits);
  const whole = abs / divisor;
  if (locale) {
    const formats = lastMoneyFormats?.locale === locale ? lastMoneyFormats : (lastMoneyFormats = moneyFormats(locale));
    const integer = formats.integer.format(whole);
    if (!digits) return `${value < 0n ? "-" : ""}${currencyCode} ${integer}`;
    let fraction = formats.fractions.get(digits);
    if (!fraction) {
      fraction = new Intl.NumberFormat(locale, { useGrouping: false, minimumIntegerDigits: digits, maximumFractionDigits: 0 });
      formats.fractions.set(digits, fraction);
    }
    return `${value < 0n ? "-" : ""}${currencyCode} ${integer}${formats.decimal}${fraction.format(abs % divisor)}`;
  }
  if (digits === 0) {
    return `${value < 0n ? "-" : ""}${currencyCode} ${whole}`;
  }
  const fraction = (abs % divisor).toString().padStart(digits, "0");
  return `${value < 0n ? "-" : ""}${currencyCode} ${whole}.${fraction}`;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function describeMissingInputs(keys: string[], names: Map<string, string> = new Map()): string[] {
  const label = (ref: string) => names.get(ref) ?? (uuid.test(ref) ? "An account" : ref);
  const describe = (key: string): string => {
    const [, subject, replacement] = /^(.+) for (.+)$/.exec(key) ?? [];
    if (subject !== undefined && replacement !== undefined) return `${describe(subject).replace(/^(An account|A balance)/, replacement)}`;
    const [kind, ...rest] = key.split(":");
    const part = (index: number) => rest[index] ?? "";
    if (kind === "balance" || kind === "available-balance") return !part(1) || part(1) === "missing" ? `${label(part(0))} needs a current balance` : part(1) === "stale" ? `${label(part(0))} has an out-of-date balance` : `${label(part(0))} balance is ${rest.slice(1).join(":")}`;
    if (kind === "rate") return `An account needs a ${rest.join(":").replace("->", " to ")} exchange rate`;
    if (kind === "currency") return `Currency ${part(0)} is not supported`;
    if (kind === "fx") return rest.length > 1 && part(0) !== "scenario" ? `${label(part(1))} needs an exchange rate` : "An exchange rate is missing";
    if (kind === "valuation") return `${names.get(part(0)) ?? "A valuation"} is dated in the future`;
    if (kind === "debt") return `A debt ${rest.slice(1).join(":") || "needs repayment terms"}`;
    if (kind === "occurrence") return `${part(0)} on ${part(1)}: evidence changed, review the association`;
    return key;
  };
  return [...new Set(keys.map(describe))];
}

export function describeOutdated(items: { name: string; asOf: string }[], date: (value: string) => string = value => value): string {
  const dates = [...new Set(items.map(item => item.asOf))].sort().reverse();
  const groups = dates.map(asOf => `${items.filter(item => item.asOf === asOf).map(item => item.name).join(", ")} (${date(asOf)})`);
  return `${items.length} ${items.length === 1 ? "valuation is not from today and uses its" : "valuations are not from today and use their"} last known value: ${groups.join("; ")}`;
}

export function formatInputAmount(amountMinor: bigint | string | number, currencyCode: string): string {
  const value = exactMinor(amountMinor);
  const abs = value < 0n ? -value : value;
  const digits = minorDigits(currencyCode);
  const divisor = 10n ** BigInt(digits);
  const whole = abs / divisor;
  if (digits === 0) {
    return `${value < 0n ? "-" : ""}${whole}`;
  }
  const fraction = (abs % divisor).toString().padStart(digits, "0");
  return `${value < 0n ? "-" : ""}${whole}.${fraction}`;
}

export function formatCompactMoney(amountMinor: bigint | string | number, currencyCode: string, locale?: string): string {
  const format = new Intl.NumberFormat(locale, { style: "currency", currency: currencyCode, currencyDisplay: "code", notation: "compact", maximumFractionDigits: 1 });
  return format.format(formatInputAmount(amountMinor, currencyCode) as `${number}`).replace(/\s/g, " ");
}

export function minorFromMajor(major: number, currencyCode: string): bigint {
  const text = major.toFixed(minorDigits(currencyCode));
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error("Amount is too large to show exactly");
  return BigInt(text.replace(".", ""));
}

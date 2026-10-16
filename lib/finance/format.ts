import { minorDigits } from "./fx";

function exactMinor(value: bigint | string | number): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("Unsafe minor amount");
  return BigInt(value);
}

export function formatMoney(amountMinor: bigint | string | number, currencyCode: string, locale?: string): string {
  const value = exactMinor(amountMinor);
  const abs = value < 0n ? -value : value;
  const digits = minorDigits(currencyCode);
  const divisor = 10n ** BigInt(digits);
  const whole = abs / divisor;
  if (locale) {
    const integer = new Intl.NumberFormat(locale, { useGrouping: false, maximumFractionDigits: 0 }).format(whole);
    const decimal = new Intl.NumberFormat(locale).formatToParts(1.1).find(part => part.type === "decimal")?.value ?? ".";
    const fraction = new Intl.NumberFormat(locale, { useGrouping: false, minimumIntegerDigits: Math.max(1, digits), maximumFractionDigits: 0 }).format(abs % divisor);
    return `${value < 0n ? "-" : ""}${currencyCode} ${integer}${digits ? decimal + fraction : ""}`;
  }
  if (digits === 0) {
    return `${value < 0n ? "-" : ""}${currencyCode} ${whole}`;
  }
  const fraction = (abs % divisor).toString().padStart(digits, "0");
  return `${value < 0n ? "-" : ""}${currencyCode} ${whole}.${fraction}`;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Turns internal missing-input keys (e.g. "balance:<id>:missing") into short,
// deduplicated sentences. Unknown keys pass through unchanged.
export function describeMissingInputs(keys: string[], names: Map<string, string> = new Map()): string[] {
  const label = (ref: string) => names.get(ref) ?? (uuid.test(ref) ? "An account" : ref);
  const describe = (key: string): string => {
    const named = /^(.+) for (.+)$/.exec(key);
    if (named) return `${describe(named[1]).replace(/^(An account|A balance)/, named[2])}`;
    const [kind, ...rest] = key.split(":");
    if (kind === "balance" || kind === "available-balance") return !rest[1] || rest[1] === "missing" ? `${label(rest[0])} needs a current balance` : rest[1] === "stale" ? `${label(rest[0])} has an out-of-date balance` : `${label(rest[0])} balance is ${rest.slice(1).join(":")}`;
    if (kind === "rate") return `An account needs a ${rest.join(":").replace("->", " to ")} exchange rate`;
    if (kind === "currency") return `Currency ${rest[0]} is not supported`;
    if (kind === "fx") return rest.length > 1 && rest[0] !== "scenario" ? `${label(rest[1])} needs an exchange rate` : "An exchange rate is missing";
    if (kind === "valuation") return rest[1] === "future" ? "A valuation is dated in the future" : "A valuation is not from today";
    if (kind === "debt") return `A debt ${rest.slice(1).join(":") || "needs repayment terms"}`;
    if (kind === "occurrence") return `${rest[0]} on ${rest[1]}: evidence changed, review the association`;
    return key;
  };
  return [...new Set(keys.map(describe))];
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

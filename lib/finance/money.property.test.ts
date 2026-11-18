import { describe, expect, it } from "vitest";
import { checkProperty, fc } from "@/lib/property-check";
import { formatInputAmount, formatMoney, minorFromMajor } from "./format";
import { convertFx } from "./fx";
import { netWorth, summarizeCashflow, type CashflowTransaction } from "./calculations";

const BEYOND_SAFE = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
const magnitude = fc.oneof(
  fc.bigInt({ min: 0n, max: 1_000_000n }),
  fc.bigInt({ min: BEYOND_SAFE, max: 10n ** 30n }),
);
const amount = fc.tuple(magnitude, fc.boolean()).map(([value, negative]) => (negative ? -value : value));
const currencies = fc.constantFrom({ code: "JPY", digits: 0 }, { code: "EUR", digits: 2 }, { code: "USD", digits: 2 }, { code: "KWD", digits: 3 }, { code: "BHD", digits: 3 });

describe("exact amounts beyond Number.MAX_SAFE_INTEGER", () => {
  it("a net worth is the exact sum however the balances are ordered or split", () => {
    checkProperty("net worth is the exact sum", fc.property(fc.array(amount, { maxLength: 12 }), fc.nat(12), (amounts, split) => {
      const balances = amounts.map(amountMinor => ({ amountMinor, currencyCode: "EUR" }));
      const exact = amounts.reduce((total, value) => total + value, 0n);
      const cut = Math.min(split, balances.length);
      expect(netWorth(balances, "EUR")).toBe(exact);
      expect(netWorth([...balances].reverse(), "EUR")).toBe(exact);
      expect(netWorth(balances.slice(0, cut), "EUR")! + netWorth(balances.slice(cut), "EUR")!).toBe(exact);
      expect(netWorth([...balances, ...balances.map(balance => ({ ...balance, amountMinor: -balance.amountMinor! }))], "EUR")).toBe(0n);
    }));
  });

  it("cashflow nets exactly the posted, non-transfer, reviewed rows and ignores pending and transfer rows", () => {
    const counted = fc.array(fc.record({ amountMinor: amount, kind: fc.constantFrom("ordinary" as const, "refund" as const) }), { maxLength: 10 })
      .map(rows => rows.map(row => ({ ...row, amountMinor: row.kind === "refund" && row.amountMinor < 0n ? -row.amountMinor : row.amountMinor })));
    const ignored = fc.array(fc.record({ amountMinor: amount, ignoredAs: fc.constantFrom("pending", "transfer") }), { maxLength: 6 });
    checkProperty("cashflow nets exactly the counted rows", fc.property(counted, ignored, (countedRows, ignoredRows) => {
      const transactions: CashflowTransaction[] = [
        ...ignoredRows.map(row => ({ amountMinor: row.amountMinor, currencyCode: "EUR", status: row.ignoredAs === "pending" ? "pending" as const : "posted" as const, kind: row.ignoredAs === "transfer" ? "transfer" as const : "ordinary" as const })),
        ...countedRows.map(row => ({ amountMinor: row.amountMinor, currencyCode: "EUR", status: "posted" as const, kind: row.kind })),
      ];
      const expectedNet = countedRows.reduce((total, row) => total + row.amountMinor, 0n);
      const summary = summarizeCashflow(transactions, "EUR")!;
      expect(summary.netMinor).toBe(expectedNet);
      expect(summary.incomeMinor - summary.spendingMinor).toBe(expectedNet);
      expect(summarizeCashflow([...transactions].reverse(), "EUR")!.netMinor).toBe(expectedNet);
    }));
  });

  it("converting between currencies keeps every digit and is off by at most half a unit when digits are dropped", () => {
    checkProperty("fx stays exact", fc.property(amount, (value) => {
      const same = convertFx({ amountMinor: value, from: "EUR", to: "USD", rate: "1", source: "synthetic", date: "2026-01-15" });
      expect(same.status === "available" && same.converted.amountMinor).toBe(value);
      const widened = convertFx({ amountMinor: value, from: "JPY", to: "KWD", rate: "1", source: "synthetic", date: "2026-01-15" });
      expect(widened.status === "available" && widened.converted.amountMinor).toBe(value * 1000n);
      const narrowed = convertFx({ amountMinor: value, from: "KWD", to: "JPY", rate: "1", source: "synthetic", date: "2026-01-15" });
      if (narrowed.status !== "available") throw new Error("A rate was given");
      const whole = narrowed.converted.amountMinor;
      const error = whole * 1000n - value;
      expect(error < 0n ? -error : error).toBeLessThanOrEqual(500n);
      const mirrored = convertFx({ amountMinor: -value, from: "KWD", to: "JPY", rate: "1", source: "synthetic", date: "2026-01-15" });
      expect(mirrored.status === "available" && mirrored.converted.amountMinor).toBe(-whole);
    }));
  });
});

describe("currency decimals", () => {
  const readBack = (text: string, digits: number) => {
    const [whole, fraction = ""] = text.replace(/^-/, "").split(".");
    expect(fraction).toHaveLength(digits);
    return BigInt(`${text.startsWith("-") ? "-" : ""}${whole}${fraction}`);
  };

  it("every amount shows exactly the currency's decimals and reads back to the same minor units", () => {
    checkProperty("decimals follow the currency", fc.property(amount, currencies, (value, { code, digits }) => {
      expect(readBack(formatInputAmount(value, code), digits)).toBe(value);
      const shown = formatMoney(value, code);
      const [, sign, text] = /^(-?)[A-Z]{3} (.+)$/.exec(shown)!;
      expect(sign === "-").toBe(value < 0n);
      expect(readBack(`${sign}${text}`, digits)).toBe(value);
    }));
  });

  it("a locale changes separators but never a digit", () => {
    const digitsOf = (text: string) => text.replace(/^-?[A-Z]{3} /, "").replace(/\D/g, "");
    checkProperty("locale keeps every digit", fc.property(amount, currencies, fc.constantFrom("en-US", "de-DE", "nl-NL"), (value, { code }, locale) => {
      expect(digitsOf(formatMoney(value, code, locale))).toBe(digitsOf(formatMoney(value, code)));
      expect(formatMoney(value, code, locale).startsWith("-")).toBe(value < 0n);
    }));
  });

  it("typed major amounts become the matching minor units", () => {
    const safe = fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n });
    checkProperty("major amounts convert exactly", fc.property(safe, currencies, (value, { code }) => {
      expect(minorFromMajor(Number(formatInputAmount(value, code)), code)).toBe(value);
    }));
  });
});

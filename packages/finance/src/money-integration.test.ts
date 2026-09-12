import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { moneyFromJSON, moneyToJSON } from "@moneo/shared/money";
import { toCanonicalFields } from "./canonicalize.js";
import { previewMappedRows, resolveMapping } from "./mapping.js";

/**
 * Issue 4.4 — exact money integration check.
 *
 * The shared utilities from Issue 0.9 (`@moneo/shared/money`) are the single
 * canonical money implementation; this issue adds NO second copy. These
 * tests lock the integration in place:
 *
 * 1. No finance source file converts money through a float path
 *    (`parseFloat(x) * 100` or equivalent) — the only `parseFloat` in the
 *    package parses Excel date serials, never amounts.
 * 2. Statement amounts survive the full pipeline — mapping preview →
 *    canonical fields → exact JSON — without precision loss for EUR (2),
 *    JPY (0), and BHD (3) exponents.
 * 3. Minor units serialize as decimal strings in JSON, never numbers.
 */
describe("exact money integration (issue 4.4)", () => {
  it("uses no float-based money conversion anywhere in the finance package", () => {
    const dir = new URL("./", import.meta.url);
    const sources = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .sort();
    expect(sources.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of sources) {
      const text = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      // `parseFloat(amount) * 100` (any spacing/parens) is the banned
      // authoritative conversion. Excel serial-date parsing has no `* 100`.
      if (/parseFloat[\s\S]{0,60}\*\s*100/.test(text)) {
        offenders.push(file);
      }
      if (/Number\s*\([^)]*\)\s*\*\s*100/.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("carries EUR/JPY/BHD amounts exactly from statement row to canonical fields", () => {
    const headers = ["Date", "Description", "Amount", "Currency"];
    const mapping = resolveMapping(headers);
    const { preview, errors } = previewMappedRows({
      headers,
      rows: [
        { rowNumber: 1, cells: ["2026-08-15", "COFFEE BAR", "1.234,56", "EUR"] },
        { rowNumber: 2, cells: ["2026-08-16", "TOKYO SHOP", "1500", "JPY"] },
        { rowNumber: 3, cells: ["2026-08-17", "MANAMA STORE", "1.234,567", "BHD"] },
      ],
      mapping,
      previewRows: 3,
    });
    expect(errors).toEqual([]);
    expect(preview).toHaveLength(3);
    const [eur, jpy, bhd] = preview.map((p) => toCanonicalFields(p));
    expect(eur?.amountMinor).toBe("123456");
    expect(eur?.currencyCode).toBe("EUR");
    expect(jpy?.amountMinor).toBe("1500");
    expect(jpy?.currencyCode).toBe("JPY");
    expect(bhd?.amountMinor).toBe("1234567");
    expect(bhd?.currencyCode).toBe("BHD");
  });

  it("serializes minor units as decimal strings, never JSON numbers", () => {
    const json = moneyToJSON({ amountMinor: 123456n, currency: "EUR", direction: "debit" });
    expect(json).toEqual({ amount: "123456", currency: "EUR", direction: "debit" });
    expect(JSON.stringify(json)).toContain('"123456"');
    expect(moneyFromJSON(JSON.parse(JSON.stringify(json)))).toEqual({
      amountMinor: 123456n,
      currency: "EUR",
      direction: "debit",
    });
  });
});

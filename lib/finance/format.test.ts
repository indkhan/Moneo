import { describe, expect, it } from "vitest";
import { formatMoney, formatInputAmount } from "./format";

describe("formatMoney", () => {
  it("formats EUR with 2 decimals", () => {
    expect(formatMoney(12345n, "EUR")).toBe("EUR 123.45");
    expect(formatMoney(-12345n, "EUR")).toBe("-EUR 123.45");
    expect(formatMoney(0n, "EUR")).toBe("EUR 0.00");
    expect(formatMoney(100n, "EUR")).toBe("EUR 1.00");
    expect(formatMoney(1n, "EUR")).toBe("EUR 0.01");
  });

  it("formats JPY with 0 decimals", () => {
    expect(formatMoney(12345n, "JPY")).toBe("JPY 12345");
    expect(formatMoney(-12345n, "JPY")).toBe("-JPY 12345");
    expect(formatMoney(0n, "JPY")).toBe("JPY 0");
  });

  it("formats USD with 2 decimals", () => {
    expect(formatMoney(10000n, "USD")).toBe("USD 100.00");
    expect(formatMoney(-10000n, "USD")).toBe("-USD 100.00");
  });

  it("formats KRW with 0 decimals", () => {
    expect(formatMoney(12345n, "KRW")).toBe("KRW 12345");
    expect(formatMoney(-12345n, "KRW")).toBe("-KRW 12345");
    expect(formatMoney(0n, "KRW")).toBe("KRW 0");
  });

  it("formats KWD with 3 decimals", () => {
    expect(formatMoney(123456n, "KWD")).toBe("KWD 123.456");
    expect(formatMoney(-123456n, "KWD")).toBe("-KWD 123.456");
    expect(formatMoney(0n, "KWD")).toBe("KWD 0.000");
    expect(formatMoney(1000n, "KWD")).toBe("KWD 1.000");
  });

  it("accepts string input", () => {
    expect(formatMoney("12345", "EUR")).toBe("EUR 123.45");
  });
});

describe("formatInputAmount", () => {
  it("formats EUR with 2 decimals for input", () => {
    expect(formatInputAmount(12345n, "EUR")).toBe("123.45");
    expect(formatInputAmount(-12345n, "EUR")).toBe("-123.45");
    expect(formatInputAmount(0n, "EUR")).toBe("0.00");
    expect(formatInputAmount(100n, "EUR")).toBe("1.00");
    expect(formatInputAmount(1n, "EUR")).toBe("0.01");
  });

  it("formats JPY with 0 decimals for input", () => {
    expect(formatInputAmount(12345n, "JPY")).toBe("12345");
    expect(formatInputAmount(-12345n, "JPY")).toBe("-12345");
    expect(formatInputAmount(0n, "JPY")).toBe("0");
  });

  it("formats USD with 2 decimals for input", () => {
    expect(formatInputAmount(10000n, "USD")).toBe("100.00");
    expect(formatInputAmount(-10000n, "USD")).toBe("-100.00");
  });

  it("formats KRW with 0 decimals for input", () => {
    expect(formatInputAmount(12345n, "KRW")).toBe("12345");
    expect(formatInputAmount(-12345n, "KRW")).toBe("-12345");
    expect(formatInputAmount(0n, "KRW")).toBe("0");
  });

  it("formats KWD with 3 decimals for input", () => {
    expect(formatInputAmount(123456n, "KWD")).toBe("123.456");
    expect(formatInputAmount(-123456n, "KWD")).toBe("-123.456");
    expect(formatInputAmount(0n, "KWD")).toBe("0.000");
    expect(formatInputAmount(1000n, "KWD")).toBe("1.000");
  });

  it("accepts string input", () => {
    expect(formatInputAmount("12345", "EUR")).toBe("123.45");
  });
});
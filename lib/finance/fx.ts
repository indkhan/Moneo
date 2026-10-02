// Exact fiat FX conversion.
//
// All money math uses bigint minor units and the rate is an exact ratio
// (integer numerator/denominator, or a decimal string parsed to a ratio),
// so JS floating-point is never authoritative. Derived minor units use
// deterministic half-up rounding on magnitude (away from zero).
//
// Rate meaning: 1 major unit of `from` buys `numerator/denominator`
// major units of `to`.

// ISO 4217 accounting units, SIX list-one published 2026-09-17.
// https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml
// Retired ANG/BGN/CUC/HRK/SLL/ZWL remain readable at their original two-digit precision.
// Locale currency presentation defaults are not an accounting-unit definition.
const accountingDigits: Readonly<Record<string, number>> = {"AED":2,"AFN":2,"ALL":2,"AMD":2,"ANG":2,"AOA":2,"ARS":2,"AUD":2,"AWG":2,"AZN":2,"BAM":2,"BBD":2,"BDT":2,"BGN":2,"BHD":3,"BIF":0,"BMD":2,"BND":2,"BOB":2,"BOV":2,"BRL":2,"BSD":2,"BTN":2,"BWP":2,"BYN":2,"BZD":2,"CAD":2,"CDF":2,"CHE":2,"CHF":2,"CHW":2,"CLF":4,"CLP":0,"CNY":2,"COP":2,"COU":2,"CRC":2,"CUC":2,"CUP":2,"CVE":2,"CZK":2,"DJF":0,"DKK":2,"DOP":2,"DZD":2,"EGP":2,"ERN":2,"ETB":2,"EUR":2,"FJD":2,"FKP":2,"GBP":2,"GEL":2,"GHS":2,"GIP":2,"GMD":2,"GNF":0,"GTQ":2,"GYD":2,"HKD":2,"HNL":2,"HRK":2,"HTG":2,"HUF":2,"IDR":2,"ILS":2,"INR":2,"IQD":3,"IRR":2,"ISK":0,"JMD":2,"JOD":3,"JPY":0,"KES":2,"KGS":2,"KHR":2,"KMF":0,"KPW":2,"KRW":0,"KWD":3,"KYD":2,"KZT":2,"LAK":2,"LBP":2,"LKR":2,"LRD":2,"LSL":2,"LYD":3,"MAD":2,"MDL":2,"MGA":2,"MKD":2,"MMK":2,"MNT":2,"MOP":2,"MRU":2,"MUR":2,"MVR":2,"MWK":2,"MXN":2,"MXV":2,"MYR":2,"MZN":2,"NAD":2,"NGN":2,"NIO":2,"NOK":2,"NPR":2,"NZD":2,"OMR":3,"PAB":2,"PEN":2,"PGK":2,"PHP":2,"PKR":2,"PLN":2,"PYG":0,"QAR":2,"RON":2,"RSD":2,"RUB":2,"RWF":0,"SAR":2,"SBD":2,"SCR":2,"SDG":2,"SEK":2,"SGD":2,"SHP":2,"SLE":2,"SLL":2,"SOS":2,"SRD":2,"SSP":2,"STN":2,"SVC":2,"SYP":2,"SZL":2,"THB":2,"TJS":2,"TMT":2,"TND":3,"TOP":2,"TRY":2,"TTD":2,"TWD":2,"TZS":2,"UAH":2,"UGX":0,"USD":2,"USN":2,"UYI":0,"UYU":2,"UYW":4,"UZS":2,"VED":2,"VES":2,"VND":0,"VUV":0,"WST":2,"XAD":2,"XAF":0,"XCD":2,"XCG":2,"XOF":0,"XPF":0,"YER":2,"ZAR":2,"ZMW":2,"ZWG":2,"ZWL":2};

export function minorDigits(currencyCode: string): number {
  const code = currencyCode.trim().toUpperCase();
  if (!Object.hasOwn(accountingDigits, code)) throw new Error(`Invalid currency code: ${currencyCode}`);
  return accountingDigits[code];
}

export type ExactRate = { numerator: bigint; denominator: bigint } | string;

export type FxInput = {
  amountMinor: bigint;
  from: string;
  to: string;
  rate: ExactRate | null | undefined;
  source: string;
  date: string; // YYYY-MM-DD rate date
};

export type FxResult =
  | {
      status: "available";
      amountMinor: bigint;
      currencyCode: string;
      converted: { amountMinor: bigint; currencyCode: string };
      rate: { numerator: bigint; denominator: bigint };
      source: string;
      date: string;
    }
  | {
      status: "unavailable";
      missingInputs: string[];
      amountMinor: bigint;
      currencyCode: string;
    };

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function parseRate(rate: ExactRate): { numerator: bigint; denominator: bigint } {
  if (typeof rate === "string") {
    const text = rate.trim();
    const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
    if (!match) throw new Error(`Invalid rate: ${rate}`);
    const fraction = match[2] ?? "";
    return { numerator: BigInt(`${match[1]}${fraction}`), denominator: pow10(fraction.length) };
  }
  return { numerator: rate.numerator, denominator: rate.denominator };
}

function validateDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid date: ${date}`);
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) throw new Error(`Invalid date: ${date}`);
}

// Rounds the quotient num/den (den > 0) to the nearest integer, half away from zero.
function divRoundHalfUp(num: bigint, den: bigint): bigint {
  const sign = num < 0n ? -1n : 1n;
  const abs = num < 0n ? -num : num;
  return sign * ((abs * 2n + den) / (den * 2n));
}

export function convertFx(input: FxInput): FxResult {
  const { amountMinor, from, to, rate, source, date } = input;
  let fromDigits: number;
  let toDigits: number;
  try { fromDigits = minorDigits(from); }
  catch { return { status: "unavailable", missingInputs: [`currency:${from}`], amountMinor, currencyCode: from }; }
  try { toDigits = minorDigits(to); }
  catch { return { status: "unavailable", missingInputs: [`currency:${to}`], amountMinor, currencyCode: from }; }
  if (typeof amountMinor !== "bigint") throw new Error("Invalid amount: bigint minor units required");
  validateDate(date);
  if (!source) throw new Error("Invalid source");
  if (from === to) return { status: "available", amountMinor, currencyCode: from,
    converted: { amountMinor, currencyCode: to }, rate: { numerator: 1n, denominator: 1n }, source, date };
  if (rate === null || rate === undefined) return { status: "unavailable", missingInputs: [`rate:${from}->${to}`], amountMinor, currencyCode: from };
  const { numerator, denominator } = parseRate(rate);
  if (denominator <= 0n) throw new Error("Invalid rate: denominator must be positive");
  if (numerator <= 0n) throw new Error("Invalid rate: numerator must be positive");
  const scaled = amountMinor * numerator * pow10(toDigits);
  const divisor = denominator * pow10(fromDigits);
  return { status: "available", amountMinor, currencyCode: from,
    converted: { amountMinor: divRoundHalfUp(scaled, divisor), currencyCode: to },
    rate: { numerator, denominator }, source, date };
}

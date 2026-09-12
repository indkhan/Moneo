/**
 * Backwards-compatible re-export. The ISO 4217 dataset lives in
 * `@moneo/shared/currencies` (single canonical copy, Issue 0.9); this module
 * re-exports it so seed code and existing imports keep working.
 */
export {
  CURRENCIES,
  isKnownCurrency,
  minorDigitsFor,
  type CurrencySeed,
} from "@moneo/shared/currencies";

import { z } from "zod";
import { minorDigits } from "./fx";

export const forecastPreferencesSchema = z.object({
  currency_code: z.string().refine(value => { try { minorDigits(value); return true; } catch { return false; } }, "Unsupported currency"),
  safety_buffer_minor: z.string().regex(/^\d{1,19}$/).refine(value => BigInt(value) <= 9223372036854775807n),
  daily_spending_minor: z.string().regex(/^\d{1,19}$/).refine(value => BigInt(value) <= 9223372036854775807n),
  uncertainty_bps: z.number().int().min(0).max(10000),
  spending_account_id: z.uuid().nullable(),
  spending_starts_on: z.iso.date().nullable(),
}).refine(value => value.daily_spending_minor === "0" || (value.spending_account_id !== null && value.spending_starts_on !== null), "Estimated spending needs an account and start date");
export type ForecastPreferences = z.infer<typeof forecastPreferencesSchema>;
export function defaultForecastPreferences(currency: string): ForecastPreferences {
  return { currency_code: currency, safety_buffer_minor: "0", daily_spending_minor: "0", uncertainty_bps: 1000, spending_account_id: null, spending_starts_on: null };
}
// Conservative rounds downward and optimistic upward, including negative money.
export function forecastCases(amount: bigint, uncertaintyBps = 1000) {
  if (!Number.isInteger(uncertaintyBps) || uncertaintyBps < 0 || uncertaintyBps > 10000) throw new Error("Invalid uncertainty assumption");
  const magnitude = amount < 0n ? -amount : amount;
  const adjustment = (magnitude * BigInt(uncertaintyBps) + 9999n) / 10000n;
  return { expectedMinor: amount, conservativeMinor: amount - adjustment, optimisticMinor: amount + adjustment };
}

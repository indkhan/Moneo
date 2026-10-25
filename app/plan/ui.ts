import { z } from "zod";
import { parseManualAmount } from "@/app/money/transactions/input";
import type { scheduleCadences } from "@/lib/finance/cadences";

export const field = "min-h-10 rounded-[10px] border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-brand focus:ring-2 focus:ring-brand/15";
export const stackedField = "mt-1 w-full " + field;
export const button = "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-[13px] font-medium text-primary-foreground hover:opacity-90";
export const linkButton = "text-sm font-medium text-brand hover:underline";
export const card = "space-y-5 rounded-xl border border-border bg-card p-6 sm:p-7";
export const eyebrow = "eyebrow";

export const cadenceLabels: Record<(typeof scheduleCadences)[number], string> = {
  once: "Once", daily: "Daily", weekly: "Weekly", biweekly: "Every two weeks", monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly",
};

/** Clamped 0–100 share of `part` in `whole`, for progress bars only. */
export function percentOf(part: bigint, whole: bigint) {
  if (whole <= 0n || part <= 0n) return 0;
  return part >= whole ? 100 : Number(part * 100n / whole);
}

/** "10" or "2.5" percent → whole basis points (1000, 250) with exact string math. */
export function percentToBps(raw: unknown) {
  const [whole, fraction = ""] = z.string().trim().regex(/^\d{1,3}(\.\d{1,2})?$/, "Enter a percent from 0 to 100 with up to 2 decimals").parse(raw).split(".");
  return z.number().int().min(0).max(10000, "Uncertainty cannot exceed 100%").parse(Number(whole) * 100 + Number(fraction.padEnd(2, "0")));
}

export const bpsToPercent = (bps: number) => String(bps / 100);

/** Decimal currency input → positive minor-unit string, or null when the input is not a positive amount. */
export function positiveMinor(raw: string, currency: string) {
  try {
    const minor = parseManualAmount(raw, currency);
    return minor > 0n ? minor.toString() : null;
  } catch { return null; }
}

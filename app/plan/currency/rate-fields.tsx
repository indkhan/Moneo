"use client";

import { useState } from "react";
import { CurrencySelect } from "@/components/currency-select";
import { convertFx, minorDigits } from "@/lib/finance/fx";
import { formatMoney } from "@/lib/finance/format";

const inputClass = "min-h-11 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/15";

/** "1 EUR = 1.08 USD" plus a sample of 100, worked out by the same exact conversion the app uses. */
export function ratePreview(from: string, to: string, rate: string, locale?: string): string | null {
  if (from === to) return /^[A-Z]{3}$/.test(from) ? "Choose two different currencies." : null;
  if (!/^\d+(\.\d+)?$/.test(rate.trim())) return null;
  try {
    const sample = 100n * 10n ** BigInt(minorDigits(from));
    const result = convertFx({ amountMinor: sample, from, to, rate: rate.trim(), source: "preview", date: "2026-01-01" });
    if (result.status !== "available") return null;
    return `1 ${from} = ${rate.trim()} ${to}, so ${formatMoney(sample, from, locale)} shows as ${formatMoney(result.converted.amountMinor, to, locale)}.`;
  } catch { return null; }
}

export function RateFields({ from: initialFrom, to: initialTo, today, locale }: { from: string; to: string; today: string; locale?: string }) {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [rate, setRate] = useState("");
  const preview = ratePreview(from, to, rate, locale);
  return <>
    <div className="grid gap-3 sm:flex sm:flex-wrap sm:items-end">
      <label className="grid gap-1 text-sm font-medium">From<CurrencySelect name="from" label="From currency" defaultValue={initialFrom} locale={locale} onChange={setFrom} className="max-sm:w-full" /></label>
      <label className="grid gap-1 text-sm font-medium">To<CurrencySelect name="to" label="To currency" defaultValue={initialTo} locale={locale} onChange={setTo} className="max-sm:w-full" /></label>
      <label className="grid gap-1 text-sm font-medium sm:w-32">Rate<input name="rate" required placeholder="1.08" inputMode="decimal" aria-label="Rate" value={rate} onChange={event => setRate(event.target.value)} className={inputClass} /></label>
      <label className="grid gap-1 text-sm font-medium">Rate date<input name="rateDate" required type="date" defaultValue={today} max={today} aria-label="Rate date" className={inputClass} /></label>
      <label className="grid gap-1 text-sm font-medium sm:w-32">Source<input name="source" defaultValue="manual" maxLength={120} aria-label="Rate source" className={inputClass} /></label>
      <button className="min-h-11 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">Add rate</button>
    </div>
    <p aria-live="polite" className="mt-3 min-h-5 text-sm font-medium">{preview}</p>
  </>;
}

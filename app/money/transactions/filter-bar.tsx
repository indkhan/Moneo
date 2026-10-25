"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { formatInputAmount } from "@/lib/finance/format";
import { parseManualAmount } from "./input";
import { compileFilterQuery } from "./nl-filter";
import { calendarDate } from "@/lib/finance/calendar";

type Named = { id: string; name: string };
export type FilterValues = Partial<Record<"q" | "from" | "to" | "account" | "category" | "merchant" | "status" | "kind" | "direction" | "tag" | "event" | "minAmount" | "maxAmount" | "sort" | "group", string>>;

const control = "min-h-10 w-full rounded-[10px] border border-input bg-card px-3 py-2 text-[13px]";

/**
 * Compact filter bar. Everything lives in the URL; amounts are typed as
 * decimals in the account (or display) currency and converted exactly to
 * minor units before they reach the URL.
 */
export function FilterBar({ values, accounts, categories, merchants, displayCurrency, timezone = "UTC" }: {
  values: FilterValues; accounts: (Named & { currency_code: string })[]; categories: Named[]; merchants: Named[]; displayCurrency: string; timezone?: string;
}) {
  const router = useRouter();
  const [account, setAccount] = useState(values.account ?? "");
  const [error, setError] = useState("");
  const currency = accounts.find(row => row.id === account)?.currency_code ?? displayCurrency;
  const decimal = (minor?: string) => minor === undefined ? "" : formatInputAmount(minor, currency);
  const [more, setMore] = useState(Boolean(values.minAmount || values.maxAmount || values.status || values.kind || values.direction || values.tag || values.event));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const params = new URLSearchParams();
    try {
      for (const [key, raw] of form) {
        const value = String(raw).trim();
        if (!value) continue;
        params.set(key, key === "minAmount" || key === "maxAmount" ? parseManualAmount(value, currency).toString() : value);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Check the amount"); return; }
    for (const key of ["sort", "group"] as const) if (values[key]) params.set(key, values[key]!);
    setError("");
    router.push(`/money/transactions${params.size ? `?${params}` : ""}`);
  }

  function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = String(new FormData(event.currentTarget).get("ask") ?? "").trim();
    if (!text) return;
    const { params } = compileFilterQuery(text, { today: calendarDate(new Date(), timezone), currency, accounts, categories, merchants });
    const query = new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1])));
    router.push(`/money/transactions${query.size ? `?${query}` : ""}`);
  }

  return <div className="space-y-2">
  <form onSubmit={ask} role="search" aria-label="Describe transactions" className="flex gap-2">
    <input name="ask" maxLength={200} placeholder="Ask, e.g. coffee over 5 last month" aria-label="Describe what to find" className={`${control} flex-1`} />
    <button className="min-h-10 whitespace-nowrap rounded-[10px] border border-input px-3 text-[13px] hover:bg-muted">Find</button>
  </form>
  <form onSubmit={submit} role="search" aria-label="Filter transactions" className="space-y-2">
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      <input id="ledger-search" name="q" defaultValue={values.q} placeholder="Search descriptions  ( / )" aria-label="Search descriptions" maxLength={200} className={control} />
      <input name="from" type="date" defaultValue={values.from} aria-label="From date" className={control} />
      <input name="to" type="date" defaultValue={values.to} aria-label="To date" className={control} />
      <select name="account" value={account} onChange={event => setAccount(event.target.value)} aria-label="Account" className={control}><option value="">All accounts</option>{accounts.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select>
      <select name="category" defaultValue={values.category ?? ""} aria-label="Category" className={control}><option value="">All categories</option><option value="none">Uncategorized</option>{categories.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select>
      <select name="merchant" defaultValue={values.merchant ?? ""} aria-label="Merchant" className={control}><option value="">All merchants</option><option value="none">Unknown</option>{merchants.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select>
      <div className="flex gap-2 lg:col-span-2 lg:justify-end">
        <button type="button" aria-expanded={more} onClick={() => setMore(!more)} className="min-h-10 whitespace-nowrap rounded-[10px] border border-input px-3 text-[13px] hover:bg-muted">{more ? "Fewer" : "More"}</button>
        <button className="min-h-10 whitespace-nowrap rounded-[10px] bg-primary px-4 text-[13px] font-medium text-primary-foreground hover:opacity-90">Apply filters</button>
      </div>
    </div>
    <div hidden={!more} className="grid gap-2 sm:grid-cols-3 lg:grid-cols-7">
      <input key={`min-${currency}`} name="minAmount" defaultValue={decimal(values.minAmount)} placeholder={`Min amount (${currency})`} aria-label={`Minimum amount in ${currency}`} inputMode="decimal" className={control} />
      <input key={`max-${currency}`} name="maxAmount" defaultValue={decimal(values.maxAmount)} placeholder={`Max amount (${currency})`} aria-label={`Maximum amount in ${currency}`} inputMode="decimal" className={control} />
      <select name="direction" defaultValue={values.direction ?? ""} aria-label="Direction" className={control}><option value="">Money in and out</option><option value="income">Money in</option><option value="outflow">Money out</option></select>
      <select name="status" defaultValue={values.status ?? ""} aria-label="Status" className={control}><option value="">Any status</option><option value="posted">Posted</option><option value="pending">Pending</option></select>
      <select name="kind" defaultValue={values.kind ?? ""} aria-label="Type" className={control}><option value="">Any type</option><option value="ordinary">Regular</option><option value="transfer">Transfer</option><option value="refund">Refund</option></select>
      <input name="tag" defaultValue={values.tag} placeholder="Tag" aria-label="Filter by tag" maxLength={40} className={control} />
      <input name="event" defaultValue={values.event} placeholder="Trip / event group" aria-label="Filter by spending group" maxLength={120} className={control} />
    </div>
    {more && <p className="text-xs text-muted-foreground">Amounts are signed: -50 to -10 finds purchases between 10 and 50.</p>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </form>
  </div>;
}

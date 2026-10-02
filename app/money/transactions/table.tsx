import Link from "next/link";
import { formatMoney } from "@/lib/finance/format";
import { DEFAULT_SORT, toggleSort, type TransactionSort } from "./filters";

type Row = { id: string; posted_on: string; description: string; amount_minor: string; currency_code: string; status: string; kind: string; account_id: string; merchant_id?: string | null };

function amount(minor: string, currency: string, locale?: string) {
  const value = BigInt(minor);
  const abs = value < 0n ? -value : value;
  return `${value < 0n ? "−" : "+"}${formatMoney(abs,currency,locale)}`;
}

function sortHref(baseQuery: string, sort: TransactionSort, column: "date" | "amount") {
  const next = toggleSort(sort, column);
  const params = new URLSearchParams(baseQuery);
  params.delete("cursor");
  params.delete("transaction");
  if (next === DEFAULT_SORT) params.delete("sort");
  else params.set("sort", next);
  const query = params.toString();
  return query ? `/money/transactions?${query}` : "/money/transactions";
}

export function TransactionTable({ rows, accountNames, merchantNames, query, sort, baseQuery, locale }: { rows: Row[]; accountNames: Record<string, string>; merchantNames: Record<string, string>; query: string; sort: TransactionSort; baseQuery: string; locale?:string }) {
  return <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-4"><div><h2 className="text-sm font-semibold">Ledger activity</h2><p className="mt-0.5 text-xs text-slate-500">Open a transaction to review or correct its details.</p></div><span className="font-mono text-xs text-slate-500">{rows.length} shown</span></div>
    {rows.length ? <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-xs"><thead className="border-b border-slate-100 bg-slate-50/70 text-[10px] uppercase tracking-wider text-slate-500"><tr><th className="px-5 py-3 font-medium"><Link className="hover:text-blue-700" aria-label={`Sort by date (currently ${sort})`} href={sortHref(baseQuery, sort, "date")}>Date {sort.startsWith("date") ? sort.endsWith("desc") ? "↓" : "↑" : "↕"}</Link></th><th className="px-3 py-3 font-medium">Description</th><th className="px-3 py-3 font-medium">Account</th><th className="px-3 py-3 font-medium">Merchant</th><th className="px-3 py-3 font-medium">Type</th><th className="px-3 py-3 font-medium">Status</th><th className="px-5 py-3 text-right font-medium"><Link className="hover:text-blue-700" aria-label={`Sort by amount (currently ${sort})`} href={sortHref(baseQuery, sort, "amount")}>Amount {sort.startsWith("amount") ? sort.endsWith("desc") ? "↓" : "↑" : "↕"}</Link></th></tr></thead><tbody className="divide-y divide-slate-100">{rows.map(row => <tr key={row.id} className="hover:bg-blue-50/40"><td className="whitespace-nowrap px-5 py-3 font-mono text-slate-500">{row.posted_on}</td><td className="px-3 py-3"><Link className="font-medium text-slate-900 hover:text-blue-700 hover:underline" href={`/money/transactions?${query}${query ? "&" : ""}transaction=${row.id}`}>{row.description}</Link></td><td className="px-3 py-3 text-slate-600">{accountNames[row.account_id] ?? "Unknown"}</td><td className="px-3 py-3 text-slate-500">{row.merchant_id ? merchantNames[row.merchant_id] ?? "Unknown" : "Unknown"}</td><td className="px-3 py-3"><span className={`rounded px-2 py-1 capitalize ${row.kind === "transfer" ? "bg-blue-50 text-blue-700" : row.kind === "refund" ? "bg-violet-50 text-violet-700" : "bg-slate-100 text-slate-700"}`}>{row.kind}</span></td><td className="px-3 py-3"><span className={`rounded px-2 py-1 capitalize ${row.status === "posted" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>{row.status}</span></td><td className={`whitespace-nowrap px-5 py-3 text-right font-mono font-medium ${BigInt(row.amount_minor) > 0n ? "text-emerald-700" : "text-slate-900"}`}>{amount(row.amount_minor, row.currency_code, locale)}</td></tr>)}</tbody></table></div> : <p className="px-5 py-10 text-center text-sm text-slate-500">No transactions found. Adjust the filters or import a statement.</p>}
  </section>;
}

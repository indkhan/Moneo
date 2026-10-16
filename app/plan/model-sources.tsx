import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadBalanceEvidence, resolveBalances } from "@/lib/finance/balances";
import { loadWealthItems } from "@/lib/finance/wealth";
import { formatMoney } from "@/lib/finance/format";

export async function ModelSources({ db, workspace }: { db: SupabaseClient; workspace: { id: string; timezone: string; locale: string } }) {
  const [evidence, items, rates] = await Promise.all([
    loadBalanceEvidence(db, workspace.id), loadWealthItems(db, workspace.id),
    db.from("fx_rates").select("id, from_currency, to_currency, rate_text, rate_date, source").eq("workspace_id", workspace.id).order("rate_date", { ascending: false }).order("id").limit(20),
  ]);
  if (rates.error) throw rates.error;
  const balances = resolveBalances(evidence.accounts, evidence.snapshots, evidence.ledger, evidence.asOf, workspace.timezone);
  return <details className="rounded-lg border border-border p-4"><summary className="cursor-pointer font-medium">Where the numbers come from</summary>
    <p className="mt-2 text-sm text-muted-foreground">Forecasts use your current balances minus held cash, reservations and the safety buffer. Investments and assets count toward net worth, not spending.</p>
    <nav aria-label="Financial model evidence" className="mt-3 flex flex-wrap gap-4 text-sm underline"><Link href="/money/accounts">Edit accounts and archives</Link><Link href="/">Record dated balances</Link><Link href="/money/wealth">Edit valuations and debt schedules</Link><Link href="/plan/currency">Edit display currency and dated FX</Link><Link href="/money/recurring">Review recurring evidence</Link><a href="#forecast-preferences">Edit forecast defaults</a></nav>
    <h3 className="mt-5 font-medium">Account balances</h3><ul className="mt-2 space-y-2 text-sm">{balances.map(account => <li key={account.id}><strong>{account.name}{account.archived_at ? " (archived; excluded from liquid forecasts)" : ""}</strong>: {account.balance.amount_minor === null ? "Current balance unavailable" : formatMoney(account.balance.amount_minor, account.currency_code, workspace.locale)}. {account.balance.status.charAt(0).toUpperCase() + account.balance.status.slice(1).replace(/_/g, " ")}{account.balance.as_of ? ` · ${new Date(account.balance.as_of).toLocaleString(workspace.locale, { timeZone: workspace.timezone })}` : " · no dated balance"}. {account.balance.warnings.join(". ")}</li>)}</ul>{!balances.length && <p className="text-sm text-muted-foreground">No account balance sources yet.</p>}
    <h3 className="mt-5 font-medium">Manual valuations</h3><ul className="mt-2 space-y-2 text-sm">{items.map(item => { return <li key={item.id}>{item.name}: {formatMoney(item.amount_minor, item.currency_code, workspace.locale)} as of {item.as_of}. {item.linked_account_id ? "Linked account value is counted once." : item.kind === "debt" ? "Debt reduces net worth; dated repayments reduce liquid cash." : "Standalone valuation; separate from liquid cash."}</li>; })}</ul>{!items.length && <p className="text-sm text-muted-foreground">No active manual valuations yet.</p>}
    <h3 className="mt-5 font-medium">Latest 20 exchange rates</h3><ul className="mt-2 space-y-2 text-sm">{rates.data?.map(rate => <li key={rate.id}>1 {rate.from_currency} = {rate.rate_text} {rate.to_currency} · {rate.rate_date} · {rate.source}</li>)}</ul>{!rates.data?.length && <p className="text-sm text-muted-foreground">No exchange rates yet. Conversions stay unavailable without one.</p>}
  </details>;
}

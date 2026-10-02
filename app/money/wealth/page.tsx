import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { calendarDate } from "@/lib/finance/calendar";
import { debtPayments, loadWealthItems, wealthEvidence, type WealthItem } from "@/lib/finance/wealth";
import { formatMoney as formatCurrency } from "@/lib/finance/format";
import { WealthForm } from "./form";
import { removeWealthItem, undoWealthEvent } from "./actions";

export default async function WealthPage() {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/login"); }
  const { supabase, workspace } = context;
  const formatMoney=(amount:Parameters<typeof formatCurrency>[0],currency:string)=>formatCurrency(amount,currency,workspace.locale);
  const today = calendarDate(new Date(), workspace.timezone);
  const [items, accounts, assumptions, pending, history] = await Promise.all([
    loadWealthItems(supabase, workspace.id, true),
    supabase.from("accounts").select("id, name, type, currency_code, archived_at").eq("workspace_id", workspace.id).order("name"),
    supabase.from("financial_assumptions").select("id, name, amount_minor::text, currency_code, starts_on").eq("workspace_id", workspace.id).eq("confirmed", true).eq("enabled", true).eq("cadence", "monthly").is("removed_at", null).order("name"),
    supabase.from("transactions").select("id, description, amount_minor::text, currency_code, posted_on").eq("workspace_id", workspace.id).eq("status", "pending").order("posted_on", { ascending: false }).limit(100),
    supabase.from("wealth_events").select("id, item_id, before, after, created_at, undone_at").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(50),
  ]);
  for (const result of [accounts, assumptions, pending, history]) if (result.error) throw result.error;
  const active = items.filter(item => !item.removed_at);
  const evidence = wealthEvidence(active, today);
  const choices = { accounts: accounts.data ?? [], assumptions: (assumptions.data ?? []).map(item => ({ id: item.id, label: `${item.name} · ${formatMoney(item.amount_minor, item.currency_code)} · ${item.starts_on}` })),
    pending: (pending.data ?? []).map(item => ({ id: item.id, label: `${item.description} · ${formatMoney(item.amount_minor, item.currency_code)} · ${item.posted_on}` })), today, currency: workspace.display_currency };
  const itemById = new Map(items.map(item => [item.id, item]));
  return <main className="mx-auto max-w-5xl space-y-5 p-6"><header><Link href="/money/transactions" className="text-sm underline">Money ledger</Link><h1 className="mt-3 text-2xl font-semibold">Investments, assets and debts</h1><p className="mt-2 text-sm text-muted-foreground">Dated manual evidence with exact money, retained history and undo. Account balances and standalone wealth are counted separately; linked values are counted by their account.</p></header>
    {evidence.missingInputs.length > 0 && <p role="status" className="text-sm text-amber-700">Current net worth is partial: {evidence.missingInputs.length} standalone valuations are historical or future dated. Update their valuation date and value before using them as current evidence.</p>}
    <section aria-label="Add wealth" className="grid gap-3">{(["holding", "asset", "debt"] as const).map(kind => <details key={kind} className="rounded border p-4"><summary className="cursor-pointer font-medium">Add {kind}</summary><WealthForm kind={kind} {...choices} /></details>)}</section>
    <section aria-label="Wealth records" className="space-y-4">{active.map(item => {
      const payments = (() => { try { return item.kind === "debt" && item.next_payment_on && BigInt(item.monthly_payment_minor ?? "0") > 0n ? debtPayments({ principalMinor: BigInt(item.amount_minor), annualRate: item.annual_rate_text!, monthlyPaymentMinor: BigInt(item.monthly_payment_minor!), nextPaymentOn: item.next_payment_on }, today, 365) : []; } catch { return null; } })();
      return <article key={item.id} className="rounded border p-4"><h2 className="font-semibold">{item.name}</h2><p>{formatMoney(item.amount_minor, item.currency_code)} · {item.kind} · as of {item.as_of}</p><p className="mt-1 text-xs text-muted-foreground">{item.linked_account_id ? "Already included in linked account balance; excluded from additional net worth." : item.as_of === today ? "Standalone current manual valuation." : "Historical manual valuation; current net worth excludes it."}</p>
        {item.kind === "holding" && <p className="mt-2 text-sm">{item.quantity_text} units at {item.currency_code} {item.unit_price_text} each.</p>}
        {item.cost_basis_minor !== null && <p className="mt-1 text-sm">Cost basis {formatMoney(item.cost_basis_minor, item.currency_code)}; valuation gain/loss {formatMoney(BigInt(item.amount_minor) - BigInt(item.cost_basis_minor), item.currency_code)}. This is unrealized value change, without guessed cash dividends or trading history.</p>}
        {item.kind === "debt" && <><p className="mt-2 text-sm">Outstanding principal {formatMoney(item.amount_minor, item.currency_code)}; nominal annual rate {item.annual_rate_text}%; monthly repayment {formatMoney(item.monthly_payment_minor ?? "0", item.currency_code)}.</p>{payments === null ? <p className="text-xs text-amber-700">Update the next repayment date and outstanding principal before projecting payments.</p> : <ul className="mt-2 text-xs">{payments.slice(0, 3).map(payment => <li key={payment.date}>{payment.date}: {formatMoney(payment.paymentMinor, item.currency_code)} payment, {formatMoney(payment.interestMinor, item.currency_code)} assumed interest, {formatMoney(payment.remainingMinor, item.currency_code)} remaining principal</li>)}</ul>}</>}
        <details className="mt-3"><summary className="cursor-pointer text-sm underline">Edit valuation and details</summary><WealthForm kind={item.kind} item={item} {...choices} /></details>
        <form action={removeWealthItem} className="mt-3"><input type="hidden" name="id" value={item.id} /><input type="hidden" name="version" value={item.version} /><input type="hidden" name="requestId" value={crypto.randomUUID()} /><button className="text-sm underline">Remove wealth record (keep history)</button></form>
      </article>;
    })}{!active.length && <p className="text-sm text-muted-foreground">No wealth records yet.</p>}</section>
    <details className="rounded border p-4"><summary className="cursor-pointer font-medium">Wealth source history and undo</summary><ul className="mt-3 space-y-3">{history.data?.map(event => {
      const after = event.after as WealthItem; const before = event.before as WealthItem | null; const current = itemById.get(event.item_id);
      return <li key={event.id} className="rounded border p-3 text-sm"><p>{after.name} · {new Date(event.created_at).toLocaleString(workspace.locale, { timeZone: workspace.timezone })}{event.undone_at ? " · Undone" : ""}</p><p>{before ? formatMoney(before.amount_minor, before.currency_code) : "New manual source"} → {formatMoney(after.amount_minor, after.currency_code)} · valued {after.as_of}{after.removed_at ? " · Removed" : ""}</p>{!event.undone_at && current && <form action={undoWealthEvent} className="mt-2"><input type="hidden" name="eventId" value={event.id} /><input type="hidden" name="version" value={current.version} /><button className="underline">Undo wealth change</button></form>}</li>;
    })}</ul></details>
  </main>;
}

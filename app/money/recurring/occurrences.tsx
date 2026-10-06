import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { associateOccurrence, undoOccurrence } from "./actions";
import { formatMoney } from "./series";

export async function OccurrenceReview({ supabase, workspace, accountNames }: { supabase: SupabaseClient; workspace: { id: string; locale: string }; accountNames: Record<string, string> }) {
  const [assumptions, transactions, settlements] = await Promise.all([
    supabase.from("financial_assumptions").select("id, name, version, amount_minor::text, currency_code, starts_on").eq("workspace_id", workspace.id).eq("confirmed", true).eq("enabled", true).is("removed_at", null).in("cadence", ["weekly", "monthly"]).order("name").limit(500),
    supabase.from("transactions").select("id, account_id, description, version, posted_on, status, amount_minor::text, currency_code").eq("workspace_id", workspace.id).eq("kind", "ordinary").eq("review_reasons", "{}").in("status", ["pending", "posted"]).order("posted_on", { ascending: false }).limit(500),
    supabase.from("recurring_occurrence_settlements").select("id, assumption_id, transaction_id, scheduled_on, completes_occurrence, undone_at, version, receipt").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(500),
  ]);
  if (assumptions.error || transactions.error || settlements.error) return <section aria-label="Occurrence reconciliation" role="alert">Could not load occurrence associations. Reload to review settlements.</section>;
  const names = new Map((assumptions.data ?? []).map(row => [row.id, row.name]));
  const inputClass = "rounded border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950";
  return <section aria-label="Occurrence reconciliation" className="space-y-4 rounded-lg border border-slate-300 p-4 dark:border-slate-700">
    <h2 className="text-lg font-semibold">Reconcile a recurring occurrence</h2>
    <p className="max-w-3xl text-sm text-slate-500">Choose the exact transaction and scheduled date it fulfills. Full settlement closes that occurrence even when the amount changed; partial settlement keeps the remainder due. Pending income stays projected; held expenses count once. Changed financial evidence restores the obligation until reviewed again. No similar transactions are matched automatically.</p>
    <form action={associateOccurrence} className="grid gap-3 md:grid-cols-2">
      <label className="grid gap-1 text-sm">Confirmed assumption<select name="assumption" required className={inputClass} defaultValue=""><option value="" disabled>Select assumption</option>{(assumptions.data ?? []).map(row => <option key={row.id} value={`${row.id}:${row.version}`}>{row.name} · {formatMoney(row.amount_minor, row.currency_code, workspace.locale)} · starts {row.starts_on}</option>)}</select></label>
      <label className="grid gap-1 text-sm">Scheduled occurrence date<input name="scheduledOn" type="date" required className={inputClass} /></label>
      <label className="grid gap-1 text-sm">Transaction<select name="transaction" required className={inputClass} defaultValue=""><option value="" disabled>Select exact transaction</option>{(transactions.data ?? []).map(row => <option key={row.id} value={`${row.id}:${row.version}`}>{row.posted_on} · {accountNames[row.account_id] ?? "Account"} · {row.description} · {formatMoney(row.amount_minor, row.currency_code, workspace.locale)} · {row.status} · {row.id}</option>)}</select></label>
      <label className="grid gap-1 text-sm">Fulfillment<select name="fulfillment" className={inputClass} defaultValue="partial"><option value="partial">Partial — keep remainder due</option><option value="full">Full — close this occurrence</option></select></label>
      <button type="submit" className="w-fit rounded bg-blue-700 px-4 py-2 text-sm text-white">Associate occurrence</button>
    </form>
    <p className="text-xs text-slate-500">Lists show up to 500 assumptions, the latest 500 eligible transactions and the latest 500 associations. Source transactions are preserved. Undo an association before replacing it with a new transaction or amount.</p>
    <ul className="space-y-2">{(settlements.data ?? []).map(row => <li key={row.id} className="flex flex-wrap items-center gap-3 text-sm">
      <span>{names.get(row.assumption_id) ?? "Assumption"} · {row.scheduled_on} · recorded {row.completes_occurrence ? "full" : "partial"} settlement{row.undone_at ? " · undone" : ""}</span>
      <Link href={`/money/transactions?transaction=${row.transaction_id}`} className="underline">Transaction evidence</Link>
      {!row.undone_at && <form action={undoOccurrence}><input type="hidden" name="settlementId" value={row.id} /><input type="hidden" name="version" value={row.version} /><button className="underline">Undo occurrence association</button></form>}
    </li>)}</ul>
  </section>;
}

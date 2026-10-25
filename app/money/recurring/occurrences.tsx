import Link from "next/link";
import { recurringCadences } from "@/lib/finance/cadences";
import type { SupabaseClient } from "@supabase/supabase-js";
import { associateOccurrence, undoOccurrence } from "./actions";
import { formatMoney } from "./series";

export async function OccurrenceReview({ supabase, workspace, accountNames }: { supabase: SupabaseClient; workspace: { id: string; locale: string }; accountNames: Record<string, string> }) {
  const [assumptions, transactions, settlements] = await Promise.all([
    supabase.from("financial_assumptions").select("id, name, version, amount_minor::text, currency_code, starts_on").eq("workspace_id", workspace.id).eq("confirmed", true).eq("enabled", true).is("removed_at", null).in("cadence", recurringCadences).order("name").limit(500),
    supabase.from("transactions").select("id, account_id, description, version, posted_on, status, amount_minor::text, currency_code").eq("workspace_id", workspace.id).eq("kind", "ordinary").eq("review_reasons", "{}").in("status", ["pending", "posted"]).order("posted_on", { ascending: false }).limit(500),
    supabase.from("recurring_occurrence_settlements").select("id, assumption_id, transaction_id, scheduled_on, completes_occurrence, undone_at, version, receipt").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(500),
  ]);
  if (assumptions.error || transactions.error || settlements.error) return <section aria-label="Occurrence reconciliation" role="alert">Could not load occurrence associations. Reload to review settlements.</section>;
  // Nothing to match against until a schedule is confirmed.
  if (!assumptions.data?.length && !settlements.data?.length) return null;
  const names = new Map((assumptions.data ?? []).map(row => [row.id, row.name]));
  const inputClass = "min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm";
  return <section aria-label="Occurrence reconciliation" className="space-y-3">
    <div>
      <h2 className="text-sm font-medium">Match a payment to a schedule</h2>
      <p className="mt-1 text-xs text-muted-foreground">Pick the transaction that paid a scheduled date. Nothing is matched automatically; undo a match before replacing it.</p>
    </div>
    <form action={associateOccurrence} className="grid gap-3 rounded-xl border border-border bg-card p-4 md:grid-cols-2">
      <label className="grid gap-1 text-sm">Confirmed assumption<select name="assumption" required className={inputClass} defaultValue=""><option value="" disabled>Select assumption</option>{(assumptions.data ?? []).map(row => <option key={row.id} value={`${row.id}:${row.version}`}>{row.name} · {formatMoney(row.amount_minor, row.currency_code, workspace.locale)} · starts {row.starts_on}</option>)}</select></label>
      <label className="grid gap-1 text-sm">Scheduled occurrence date<input name="scheduledOn" type="date" required className={inputClass} /></label>
      <label className="grid gap-1 text-sm">Transaction<select name="transaction" required className={inputClass} defaultValue=""><option value="" disabled>Select exact transaction</option>{(transactions.data ?? []).map(row => <option key={row.id} value={`${row.id}:${row.version}`}>{row.posted_on} · {accountNames[row.account_id] ?? "Account"} · {row.description} · {formatMoney(row.amount_minor, row.currency_code, workspace.locale)} · {row.status}</option>)}</select></label>
      <label className="grid gap-1 text-sm">Fulfillment<select name="fulfillment" className={inputClass} defaultValue="partial"><option value="partial">Partial — keep remainder due</option><option value="full">Full — close this occurrence</option></select></label>
      <button type="submit" className="min-h-10 w-fit rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Associate occurrence</button>
    </form>
    <ul className="divide-y divide-border empty:hidden">{(settlements.data ?? []).map(row => <li key={row.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
      <span>{names.get(row.assumption_id) ?? "Assumption"} · {row.scheduled_on} · recorded {row.completes_occurrence ? "full" : "partial"} settlement{row.undone_at ? " · undone" : ""}</span>
      <Link href={`/money/transactions?transaction=${row.transaction_id}`} className="underline">Transaction evidence</Link>
      {!row.undone_at && <form action={undoOccurrence}><input type="hidden" name="settlementId" value={row.id} /><input type="hidden" name="version" value={row.version} /><button className="underline">Undo occurrence association</button></form>}
    </li>)}</ul>
  </section>;
}

import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { expandSchedule } from "@/lib/finance/model";
import { undoOccurrence } from "./actions";
import { OccurrenceForm } from "./occurrence-form";
import { formatMoney } from "@/lib/recurring/series";
import { ActionForm } from "./forms";

type Schedule = { id: string; name: string; version: number; account_id: string | null; amount_minor: string; currency_code: string; cadence: string; starts_on: string; ends_on: string | null; schedule_anchor_on: string | null };

export async function OccurrenceReview({ supabase, workspace, accountNames, schedules }: {
  supabase: SupabaseClient; workspace: { id: string; locale: string }; accountNames: Record<string, string>; schedules: Schedule[] | null;
}) {
  const [transactions, settlements] = await Promise.all([
    schedules?.length ? supabase.from("transactions").select("id, account_id, description, version, posted_on, status, amount_minor::text, currency_code").eq("workspace_id", workspace.id).eq("kind", "ordinary").eq("review_reasons", "{}").in("status", ["pending", "posted"]).order("posted_on", { ascending: false }).limit(500) : { data: [], error: null },
    supabase.from("recurring_occurrence_settlements").select("id, assumption_id, transaction_id, scheduled_on, completes_occurrence, undone_at, version, receipt").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(500),
  ]);
  if (!schedules || transactions.error || settlements.error) return <section aria-label="Occurrence reconciliation" role="alert">Could not load occurrence associations. Reload to review settlements.</section>;
  if (!schedules.length && !settlements.data?.length) return null;
  const names = new Map(schedules.map(row => [row.id, row.name]));
  const start = new Date(new Date().getTime() - 62 * 86_400_000).toISOString().slice(0, 10);
  const scheduleOptions = schedules.map(row => ({ value: `${row.id}:${row.version}`, accountId: row.account_id, currency: row.currency_code, amountMinor: row.amount_minor,
    label: `${row.name} · ${formatMoney(row.amount_minor, row.currency_code, workspace.locale)} · starts ${row.starts_on}`,
    dates: expandSchedule({ ...row, account_id: row.account_id ?? "unassigned" }, start, 92).map(item => item.date).filter((date, index, all) => all.indexOf(date) === index).slice(0, 12) }));
  const transactionOptions = (transactions.data ?? []).map(row => ({ value: `${row.id}:${row.version}`, accountId: row.account_id as string, currency: row.currency_code as string, amountMinor: row.amount_minor as string,
    label: `${row.posted_on} · ${accountNames[row.account_id] ?? "Account"} · ${row.description} · ${formatMoney(row.amount_minor, row.currency_code, workspace.locale)} · ${row.status}` }));
  return <section aria-label="Occurrence reconciliation"><details open={(settlements.data ?? []).some(row => !row.undone_at)} className="space-y-3">
    <summary className="cursor-pointer text-sm font-medium">Mark a scheduled payment as paid</summary>
    <p className="mt-1 text-xs text-muted-foreground">Pick the transaction that paid a scheduled date, so the forecast stops expecting it. Undo a match before replacing it.</p>
    <OccurrenceForm key={(settlements.data ?? []).length} schedules={scheduleOptions} transactions={transactionOptions} />
    <ul className="divide-y divide-border empty:hidden">{(settlements.data ?? []).map(row => <li key={row.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
      <span>{names.get(row.assumption_id) ?? "Assumption"} · {row.scheduled_on} · recorded {row.completes_occurrence ? "full" : "partial"} settlement{row.undone_at ? " · undone" : ""}</span>
      <Link href={`/money/transactions?transaction=${row.transaction_id}`} className="underline">Transaction evidence</Link>
      {!row.undone_at && <ActionForm action={undoOccurrence} hidden={{ settlementId: row.id, version: String(row.version) }}><button className="underline">Undo</button></ActionForm>}
    </li>)}</ul>
  </details></section>;
}

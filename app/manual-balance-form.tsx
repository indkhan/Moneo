import { randomUUID } from "node:crypto";
import { setManualBalance, undoManualBalance } from "./actions";
import { balanceReviewRows, type BalanceAccount, type BalanceSnapshot, type BalanceTransaction } from "@/lib/finance/balances";
import { calendarDate } from "@/lib/finance/calendar";
import { formatMoney } from "@/lib/finance/format";
import { buildSourceCoverage, type SourceCoverage } from "@/lib/finance/source-coverage";
import { SourceCoverageDetails } from "./source-coverage";

export function ManualBalanceForm({ account, snapshots, ledger, asOf, timeZone, locale }: {
  account: BalanceAccount & { sourceCoverage?: SourceCoverage }; snapshots: BalanceSnapshot[]; ledger: BalanceTransaction[]; asOf: string; timeZone: string; locale: string;
}) {
  const history = snapshots.filter(row => row.account_id === account.id).sort((a, b) =>
    Date.parse(b.created_at ?? b.as_of) - Date.parse(a.created_at ?? a.as_of) ||
    (b.created_at ?? b.as_of).localeCompare(a.created_at ?? a.as_of) || (b.id ?? "").localeCompare(a.id ?? ""));
  const latest = history[0];
  const review = balanceReviewRows(ledger, account.id, asOf, timeZone);
  const descriptions = new Map(ledger.map(row => [row.id, row.description]));
  const today = calendarDate(asOf, timeZone);
  return <>
    <SourceCoverageDetails coverage={account.sourceCoverage ?? buildSourceCoverage({ from: "0001-01-01", to: today, accountId: account.id, currencyCode: account.currency_code, ledgerBasis: "balance_activity" }, ledger.map(row => ({ ...row, kind: row.kind ?? "ordinary" })))} />
    <form action={setManualBalance} className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4 text-xs">
      <input type="hidden" name="accountId" value={account.id} />
      <input type="hidden" name="requestId" value={randomUUID()} />
      <input type="hidden" name="expectedSnapshotId" value={latest?.id ?? ""} />
      <input type="hidden" name="expectedVersion" value={latest?.version ?? 0} />
      <input type="hidden" name="coveredTransactions" value={JSON.stringify(review)} />
      <input name="amount" required placeholder="Booked balance" aria-label={`${account.name} balance`} className="w-24 rounded-md border border-border bg-card p-2" />
      <input name="asOf" required type="date" defaultValue={today} max={today} aria-label="Balance as of" className="min-w-0 rounded-md border border-border bg-card p-2" />
      <button className="font-medium text-brand hover:underline">Save</button>
      <details className="w-full">
        <summary className="cursor-pointer">Review activity included in today&apos;s booked balance ({review.length})</summary>
        <p className="mt-2 text-muted-foreground">Check your bank&apos;s booked balance before pending holds. Confirm only if it includes every posting below. Refresh this page if activity changes.</p>
        <ul className="mt-2 max-h-60 space-y-1 overflow-auto">
          {review.map(row => <li key={row.id}>{descriptions.get(row.id) ?? "Recorded posting"} — {formatMoney(row.amount_minor, row.currency_code, locale)} — {row.posted_at ? new Date(row.posted_at).toLocaleString(locale, { timeZone }) : `${row.posted_on} (date only)`}</li>)}
        </ul>
        {review.length === 0 && <p className="mt-2 text-muted-foreground">No posted activity recorded today.</p>}
        <label className="mt-3 flex items-start gap-2"><input type="checkbox" name="reviewedActivity" className="mt-0.5" /><span>I checked today&apos;s booked balance and confirm it includes all {review.length} listed postings.</span></label>
        <p className="mt-2 text-muted-foreground">Without confirmation, same-day activity may leave the balance uncertain. This review applies only to today&apos;s date.</p>
      </details>
    </form>
    {history.some(row => row.actor_id) && <details className="mt-3 text-xs"><summary className="cursor-pointer">Manual balance history and undo</summary>
      <ul className="mt-2 space-y-2">{history.filter(row => row.actor_id).map(row => <li key={row.id}>
        {formatMoney(row.amount_minor, row.currency_code, locale)} — {new Date(row.as_of).toLocaleString(locale, { timeZone })} — {row.boundary_kind === "reviewed_activity" ? "activity reviewed" : "date only"}
        {row.undone_at ? <span> — undone</span> : <form action={undoManualBalance} className="inline ml-2">
          <input type="hidden" name="snapshotId" value={row.id} /><input type="hidden" name="expectedVersion" value={row.version ?? 1} />
          <input type="hidden" name="expectedLatestId" value={latest?.id} /><input type="hidden" name="expectedLatestVersion" value={latest?.version ?? 1} />
          <button className="underline">Undo balance</button>
        </form>}
      </li>)}</ul>
    </details>}
  </>;
}

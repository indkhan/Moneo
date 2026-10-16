import { randomUUID } from "node:crypto";
import { setManualBalance, undoManualBalance, confirmRecordedBalance } from "./actions";
import { balanceReviewRows, resolveBalances, type BalanceAccount, type BalanceSnapshot, type BalanceTransaction } from "@/lib/finance/balances";
import { calendarDate } from "@/lib/finance/calendar";
import { formatInputAmount, formatMoney } from "@/lib/finance/format";
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
  const balance = resolveBalances([account], snapshots, ledger, asOf, timeZone)[0].balance;
  const boundary = balance.as_of ? calendarDate(balance.as_of, timeZone) : today;
  const changes = ledger.filter(row => row.account_id === account.id && row.status === "posted" &&
    (row.posted_at ? Date.parse(row.posted_at) > Date.parse(balance.as_of ?? asOf) : row.posted_on > boundary) &&
    (row.posted_at ? Date.parse(row.posted_at) <= Date.parse(asOf) : row.posted_on <= today))
    .sort((a, b) => a.posted_on.localeCompare(b.posted_on) || a.id.localeCompare(b.id));
  return <>
    <div className="mt-4"><SourceCoverageDetails coverage={account.sourceCoverage ?? buildSourceCoverage({ from: "0001-01-01", to: today, accountId: account.id, currencyCode: account.currency_code, ledgerBasis: "balance_activity" }, ledger.map(row => ({ ...row, kind: row.kind ?? "ordinary" })))} /></div>
    {!account.archived_at && balance.status === "stale" && balance.estimated_amount_minor !== null && <details className="mt-4 rounded-lg border border-border p-4 text-sm">
      <summary className="cursor-pointer font-medium text-brand">Confirm recorded balance</summary>
      <p className="mt-2">Recorded changes since {boundary} give an estimated booked balance of {formatMoney(balance.estimated_amount_minor, account.currency_code, locale)} before pending holds.</p>
      <ul className="mt-3 max-h-60 divide-y divide-border overflow-auto">{changes.map(row => <li key={row.id} className="py-1.5">{row.description ?? "Recorded posting"} — {formatMoney(row.amount_minor, row.currency_code, locale)} — {row.posted_at ? calendarDate(row.posted_at, timeZone) : row.posted_on}</li>)}</ul>
      {changes.length === 0 && <p className="mt-2">No later activity is recorded.</p>}
      <p className="mt-2 text-muted-foreground">Check this against your bank. If it differs, enter the balance below instead.</p>
      <form action={confirmRecordedBalance} className="mt-4 space-y-3">
        <input type="hidden" name="accountId" value={account.id} />
        <input type="hidden" name="requestId" value={randomUUID()} />
        <input type="hidden" name="expectedSnapshotId" value={latest?.id ?? ""} />
        <input type="hidden" name="expectedVersion" value={latest?.version ?? 0} />
        <input type="hidden" name="coveredTransactions" value={JSON.stringify(review)} />
        <input type="hidden" name="amount" value={formatInputAmount(balance.estimated_amount_minor, account.currency_code)} />
        <input type="hidden" name="asOf" value={today} />
        <label className="flex items-start gap-2"><input type="checkbox" name="reviewedActivity" required /><span>I checked my bank and confirm this booked balance before pending holds includes all recorded postings through {today}.</span></label>
        <button className="text-sm font-medium text-brand hover:underline">Confirm balance without retyping</button>
      </form>
    </details>}
    <form action={setManualBalance} className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-4 text-sm">
      <input type="hidden" name="accountId" value={account.id} />
      <input type="hidden" name="requestId" value={randomUUID()} />
      <input type="hidden" name="expectedSnapshotId" value={latest?.id ?? ""} />
      <input type="hidden" name="expectedVersion" value={latest?.version ?? 0} />
      <input type="hidden" name="coveredTransactions" value={JSON.stringify(review)} />
      <input name="amount" required placeholder="Booked balance" aria-label={`${account.name} balance`} className="min-h-10 w-32 rounded-lg border border-border bg-card px-3 py-2 text-sm" />
      <input name="asOf" required type="date" defaultValue={today} max={today} aria-label="Balance as of" className="min-h-10 min-w-0 rounded-lg border border-border bg-card px-3 py-2 text-sm" />
      <button className="min-h-10 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">Save</button>
      <details className="w-full">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Confirm today&apos;s activity ({review.length})</summary>
        <p className="mt-3 text-muted-foreground">Tick the box below if your bank&apos;s booked balance includes every posting listed here.</p>
        <ul className="mt-3 max-h-60 divide-y divide-border overflow-auto">
          {review.map(row => <li key={row.id} className="py-1.5">{descriptions.get(row.id) ?? "Recorded posting"} — {formatMoney(row.amount_minor, row.currency_code, locale)} — {row.posted_at ? new Date(row.posted_at).toLocaleString(locale, { timeZone }) : `${row.posted_on} (date only)`}</li>)}
        </ul>
        {review.length === 0 && <p className="mt-3 text-muted-foreground">No posted activity recorded today.</p>}
        <label className="mt-3 flex items-start gap-2"><input type="checkbox" name="reviewedActivity" className="mt-0.5" /><span>I checked today&apos;s booked balance and confirm it includes all {review.length} listed postings.</span></label>
      </details>
    </form>
    {history.some(row => row.actor_id) && <details className="mt-4 text-sm"><summary className="cursor-pointer text-muted-foreground hover:text-foreground">Manual balance history and undo</summary>
      <ul className="mt-3 space-y-2">{history.filter(row => row.actor_id).map(row => <li key={row.id}>
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

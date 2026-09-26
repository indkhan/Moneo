import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { detectRecurring } from "@/lib/finance/recurring";
import { confirmSeries, declineSeries } from "./actions";
import { confidenceToPercent, formatMoney, seriesKey } from "./series";

const MAX_TRANSACTIONS = 10_000;
const PAGE_SIZE = 1000;

type TxRow = {
  id: string;
  posted_on: string;
  description: string;
  amount_minor: string;
  currency_code: string;
  account_id: string;
};

export default async function RecurringPage() {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try {
    context = await requireWorkspace();
  } catch {
    redirect("/login");
  }
  const { supabase, workspace } = context;

  const [{ data: accounts, error: accountsError }, { data: stored, error: storedError }] = await Promise.all([
    supabase.from("accounts").select("id, name, currency_code").eq("workspace_id", workspace.id).order("name"),
    supabase.from("recurring_series")
      .select("account_id, normalized_label, cadence, currency_code, status, assumption_id, label")
      .eq("workspace_id", workspace.id),
  ]);

  const rows: TxRow[] = [];
  let queryError: string | null = null;
  for (let offset = 0; offset < MAX_TRANSACTIONS; offset += PAGE_SIZE) {
    const { data, error } = await supabase.from("transactions")
      .select("id, posted_on, description, amount_minor, currency_code, account_id")
      .eq("workspace_id", workspace.id)
      .eq("status", "posted")
      .eq("kind", "ordinary")
      .order("id")
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) {
      queryError = error.message;
      break;
    }
    rows.push(...((data ?? []) as TxRow[]));
    if (!data || data.length < PAGE_SIZE) break;
  }
  const truncated = rows.length >= MAX_TRANSACTIONS;

  let detected: ReturnType<typeof detectRecurring> = [];
  let detectError: string | null = null;
  if (!queryError) {
    try {
      detected = detectRecurring(rows.map((row) => ({
        id: row.id,
        date: row.posted_on,
        description: row.description,
        amountMinor: BigInt(row.amount_minor),
        currencyCode: row.currency_code,
        accountId: row.account_id,
      })));
    } catch (error) {
      detectError = error instanceof Error ? error.message : String(error);
    }
  }

  const byId = new Map(rows.map((row) => [row.id, row]));
  const names = Object.fromEntries((accounts ?? []).map((account) => [account.id, account.name]));
  const storedByKey = new Map(
    (stored ?? []).map((item) => [
      [item.account_id, item.currency_code, item.cadence, item.normalized_label].join("\0"),
      item,
    ]),
  );

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">
            <Link href="/" className="underline">Home</Link> · <Link href="/money/transactions" className="underline">Transactions</Link> · <Link href="/plan" className="underline">Plan</Link>
          </p>
          <h1 className="mt-2 text-3xl font-semibold">Recurring review</h1>
        </div>
      </header>

      <p className="mt-4 text-sm text-muted-foreground">
        Estimated patterns inferred from up to {MAX_TRANSACTIONS.toLocaleString()} posted transactions.
        Nothing here affects your forecast until you confirm it. Confirming creates one confirmed
        financial assumption used by the deterministic forecast; declining disables it.
      </p>

      {accountsError && <p role="alert" className="mt-6">Could not load accounts: {accountsError.message}</p>}
      {storedError && <p role="alert" className="mt-6">Could not load review state: {storedError.message}</p>}
      {queryError && <p role="alert" className="mt-6">Could not load transactions: {queryError}</p>}
      {detectError && <p role="alert" className="mt-6">Could not detect patterns: {detectError}</p>}
      {truncated && <p className="mt-6 text-sm text-muted-foreground">Showing the first 10,000 posted transactions.</p>}

      {!queryError && !detectError && detected.length === 0 && (
        <p className="mt-8 text-muted-foreground">No estimated recurring patterns found. Import more history to improve detection.</p>
      )}

      <div className="mt-8 space-y-4">
        {detected.map((series) => {
          const key = seriesKey({
            accountId: series.accountId,
            currencyCode: series.currencyCode,
            cadence: series.cadence,
            label: series.label,
          });
          const state = storedByKey.get(key);
          const status = state?.status ?? "pending";
          const percent = confidenceToPercent(series.confidence);
          const evidence = series.transactionIds.map((id) => byId.get(id)).filter((row): row is TxRow => Boolean(row));
          return (
            <article key={key} className="rounded-lg border p-5">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-medium">{series.label}</h2>
                <span className="rounded bg-muted px-2 py-0.5 text-xs">Estimated · {series.cadence}</span>
                {status === "confirmed" && <span className="rounded bg-muted px-2 py-0.5 text-xs">Confirmed · used in forecast</span>}
                {status === "dismissed" && <span className="rounded bg-muted px-2 py-0.5 text-xs">Dismissed · not recurring</span>}
              </div>
              <p className="mt-2 text-sm">
                {formatMoney(series.amountMinMinor.toString(), series.currencyCode)}
                {series.amountMinMinor !== series.amountMaxMinor && <> to {formatMoney(series.amountMaxMinor.toString(), series.currencyCode)}</>}
                {" · "}{names[series.accountId] ?? "Unknown account"}
                {" · "}{series.occurrences} payments · confidence {percent}%
              </p>
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer underline">Evidence ({evidence.length} posted transactions)</summary>
                <ul className="mt-2 space-y-1">
                  {evidence.slice(0, 8).map((row) => (
                    <li key={row.id} className="text-muted-foreground">
                      {row.posted_on} · {formatMoney(row.amount_minor, row.currency_code)} · {row.description}
                    </li>
                  ))}
                </ul>
                {evidence.length > 8 && <p className="mt-1 text-muted-foreground">…and {evidence.length - 8} more.</p>}
              </details>
              <div className="mt-4 flex flex-wrap gap-3">
                <form action={confirmSeries}>
                  <input type="hidden" name="accountId" value={series.accountId} />
                  <input type="hidden" name="label" value={series.label} />
                  <input type="hidden" name="cadence" value={series.cadence} />
                  <input type="hidden" name="currencyCode" value={series.currencyCode} />
                  <input type="hidden" name="amountMinMinor" value={series.amountMinMinor.toString()} />
                  <input type="hidden" name="amountMaxMinor" value={series.amountMaxMinor.toString()} />
                  <input type="hidden" name="occurrences" value={series.occurrences} />
                  <input type="hidden" name="confidence" value={percent} />
                  <input type="hidden" name="transactionIds" value={series.transactionIds.join(",")} />
                  <button className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground">Confirm</button>
                </form>
                <form action={declineSeries}>
                  <input type="hidden" name="accountId" value={series.accountId} />
                  <input type="hidden" name="label" value={series.label} />
                  <input type="hidden" name="cadence" value={series.cadence} />
                  <input type="hidden" name="currencyCode" value={series.currencyCode} />
                  <input type="hidden" name="amountMinMinor" value={series.amountMinMinor.toString()} />
                  <input type="hidden" name="amountMaxMinor" value={series.amountMaxMinor.toString()} />
                  <input type="hidden" name="occurrences" value={series.occurrences} />
                  <input type="hidden" name="confidence" value={percent} />
                  <input type="hidden" name="transactionIds" value={series.transactionIds.join(",")} />
                  <button className="rounded border px-4 py-2 text-sm">Not recurring</button>
                </form>
              </div>
            </article>
          );
        })}
      </div>
    </main>
  );
}

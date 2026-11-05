import Link from "next/link";
import { missingInputAccount } from "@/lib/finance/calculations";
import { describeMissingInputs } from "@/lib/finance/format";

export type Blocker = { key: string; text: string; action: string; href: string };

const RATES = { action: "Add rate", href: "/plan/currency" };
const WEALTH = { action: "Review wealth", href: "/money/wealth" };

/** What an account's gap means in plain words and where it gets fixed. A lower `rank` is the one to fix first. */
function accountProblem(key: string, id: string) {
  const balance = { href: `/money/accounts#account-${id}` };
  if (/^(available-)?balance:/.test(key)) {
    const reason = key.split(":").slice(2).join(":");
    if (reason === "ambiguous") return { rank: 0, reason: "its balance sources disagree. Review which one is right.", action: "Review balance", ...balance };
    if (!reason || reason === "missing") return { rank: 1, reason: "needs a current balance.", action: "Add balance", ...balance };
    if (reason === "stale") return { rank: 2, reason: "has an out-of-date balance.", action: "Update balance", ...balance };
    return { rank: 1, reason: "its balance could not be confirmed.", action: "Review balance", ...balance };
  }
  if (key.startsWith("debt") || key.startsWith("fx:debt")) return { rank: 3, reason: "a debt paid from it needs complete repayment terms.", ...WEALTH };
  return { rank: 4, reason: "needs an exchange rate.", ...RATES };
}

function generalFix(key: string) {
  if (key === "accounts") return { action: "Add account", href: "/money/accounts" };
  if (/^(rate|currency|fx):/.test(key)) return RATES;
  if (/^(valuation|debt):/.test(key)) return WEALTH;
  if (key.startsWith("occurrence:")) return { action: "Review recurring", href: "/money/recurring" };
  if (key.includes("spending account")) return { action: "Open forecast settings", href: "#forecast-preferences" };
  return { action: "Review inputs", href: "#financial-model" };
}

/** Turns the forecast's missing inputs into one line per account, each with the one link that fixes it. */
export function forecastBlockers(keys: string[], accounts: { id: string }[], names: Map<string, string>): Blocker[] {
  const known = new Set(accounts.map(account => account.id));
  const byAccount = new Map<string, ReturnType<typeof accountProblem>>();
  const general = new Map<string, Blocker>();
  for (const raw of new Set(keys)) {
    const key = raw.replace(/ for .+$/, "");
    const id = missingInputAccount(key);
    if (id && known.has(id)) {
      const problem = accountProblem(key, id), current = byAccount.get(id);
      if (!current || problem.rank < current.rank) byAccount.set(id, problem);
    } else {
      const [text] = describeMissingInputs([raw], names);
      if (!general.has(text)) general.set(text, { key: raw, text: key === "accounts" ? "Add an account to start a forecast." : text, ...generalFix(key) });
    }
  }
  return [...[...byAccount].map(([id, { reason, action, href }]) => ({ key: id, text: `${names.get(id) ?? "An account"}: ${reason}`, action, href })), ...general.values()];
}

/** The repairs behind a missing or partial forecast, shown before anything else in the section. */
export function ForecastBlockers({ blockers, unavailable }: { blockers: Blocker[]; unavailable: boolean }) {
  return <div role={unavailable ? "alert" : undefined} className="space-y-2 rounded-lg bg-muted/60 p-4 text-sm">
    <p className="font-medium">{unavailable ? "Forecast unavailable" : "Left out of this forecast"}</p>
    <p className="text-muted-foreground">{unavailable ? "Fix these to see where your cash is heading. This is not a zero balance." : "Their balances and scheduled money are not counted until you fix these."}</p>
    <ul className="divide-y divide-border">{blockers.map(blocker => <li key={blocker.key} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
      <span>{blocker.text}</span><Link href={blocker.href} className="inline-flex min-h-11 items-center font-medium text-brand underline">{blocker.action}</Link></li>)}</ul>
  </div>;
}

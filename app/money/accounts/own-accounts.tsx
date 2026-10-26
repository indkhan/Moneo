import { maskAccountNumber } from "@/lib/import/csv";
import { addOwnAccount, findTransfersBetweenOwnAccounts, removeOwnAccount } from "./actions";

const field = "min-h-9 rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm";
const quiet = "min-h-9 rounded-lg px-2.5 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground";
type Identifier = { id: string; account_id: string | null; iban: string; label: string };

function resultText(transfers?: string) {
  const [linked, marked, skipped] = (transfers ?? "").split("-").map(Number);
  if (![linked, marked, skipped].every(Number.isSafeInteger)) return null;
  const found = linked + marked;
  return `${found ? `Found ${linked} transfer ${linked === 1 ? "pair" : "pairs"}${marked ? ` and ${marked} ${marked === 1 ? "payment" : "payments"} to your untracked accounts` : ""}. They no longer count as money in or out; undo any of them from the transaction.` : "No new transfers between your accounts found."}${skipped ? ` ${skipped} need a manual link (for example because of a fee).` : ""}`;
}

// The IBANs that are the owner's own, so money moved between them is a transfer, not income or spending.
export function OwnAccounts({ identifiers, banked, accounts, transfers }: {
  identifiers: Identifier[]; banked: { iban: string; name: string }[]; accounts: { id: string; name: string }[]; transfers?: string;
}) {
  const result = resultText(transfers);
  const name = (id: string | null) => id ? accounts.find(account => account.id === id)?.name ?? "An archived account" : "Not tracked in Moneo";
  return <section id="own-accounts" aria-label="Your own accounts" className="space-y-3 rounded-xl border border-border bg-card p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="font-medium">Your own accounts</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Money you move between these accounts is a transfer: it isn’t counted as income, spending or cashflow. Add the IBAN of each account that is yours, including accounts Moneo doesn’t track.</p></div>
      <form action={findTransfersBetweenOwnAccounts}><button className={field}>Find transfers between my accounts</button></form>
    </div>
    {result ? <p role="status" className="text-sm">{result}</p> : null}
    <ul className="divide-y divide-border text-sm">
      {banked.map(item => <li key={item.iban} className="flex flex-wrap items-center justify-between gap-2 py-2"><span>{item.name} · {maskAccountNumber(item.iban)}</span><span className="text-muted-foreground">From your bank connection</span></li>)}
      {identifiers.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
        <span>{item.label} · {maskAccountNumber(item.iban)} <span className="text-muted-foreground">· {name(item.account_id)}</span></span>
        <form action={removeOwnAccount}><input type="hidden" name="id" value={item.id} /><button className={quiet}>Remove</button></form>
      </li>)}
    </ul>
    <form action={addOwnAccount} className="flex flex-wrap items-end gap-2">
      <label className="grid gap-1 text-xs text-muted-foreground">IBAN<input name="iban" required maxLength={42} className={`${field} w-64 font-mono text-foreground`} /></label>
      <label className="grid gap-1 text-xs text-muted-foreground">Name<input name="label" required maxLength={120} className={`${field} text-foreground`} /></label>
      <label className="grid gap-1 text-xs text-muted-foreground">In Moneo as<select name="accountId" className={`${field} text-foreground`}>
        <option value="">Not tracked in Moneo</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
      <button className="min-h-9 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90">Add my account</button>
    </form>
  </section>;
}

import { scheduleCadences } from "@/lib/finance/cadences";
import { formatInputAmount, formatMoney } from "@/lib/finance/format";
import { addAssumption, deleteAssumption, toggleAssumption, updateAssumption } from "./actions";
import { button, cadenceLabels, field, linkButton } from "./ui";

type Assumption = { id: string; account_id: string | null; name: string; amount_minor: string; currency_code: string; cadence: string; starts_on: string; schedule_anchor_on: string | null; ends_on: string | null; source: string; confirmed: boolean; enabled: boolean; version: number };
const label = (cadence: string) => cadenceLabels[cadence as keyof typeof cadenceLabels] ?? cadence;
const cadenceOptions = scheduleCadences.map(value => <option key={value} value={value}>{cadenceLabels[value]}</option>);

function Metadata({ item }: { item: Assumption }) {
  return <><input type="hidden" name="assumptionId" value={item.id} /><input type="hidden" name="version" value={item.version} /><input type="hidden" name="requestId" value={crypto.randomUUID()} /></>;
}

export function AssumptionList({ assumptions, error, accounts, names, locale, today }: {
  assumptions: Assumption[]; error?: string; accounts: { id: string; name: string }[]; names: Map<string, string>; locale?: string; today: string;
}) {
  return <>
    {error && <p role="alert">Could not load assumptions: {error}</p>}
    {!error && !assumptions.length && <p className="text-muted-foreground">No assumptions yet. Add one below or confirm a pattern in Money → Recurring.</p>}
    <ul className="divide-y divide-border rounded-lg border border-border">{assumptions.map(item => <li key={`${item.id}:${item.version}`} className="p-4 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="font-medium">{item.name}{item.enabled ? "" : " (disabled)"}</h3><p className="font-mono">{formatMoney(item.amount_minor, item.currency_code, locale)}</p></div>
      <p className="mt-1 text-muted-foreground">{label(item.cadence)} from {item.starts_on}{item.ends_on ? ` until ${item.ends_on}` : ""}{item.account_id ? ` · ${names.get(item.account_id) ?? "Unknown account"}` : " · no account"}</p>
      {item.schedule_anchor_on && <p className="text-muted-foreground">Calendar anchor: {item.schedule_anchor_on}. Month-end dates shift to the last valid day.</p>}
      <p className="mt-1 text-muted-foreground">{item.source === "recurring_confirmed" ? "Detected from your transactions" : "Added by you"} · {item.confirmed ? "Confirmed" : "Estimated"} · {item.enabled ? "Used in forecast" : "Not used in forecast"}</p>
      <div className="mt-2 flex flex-wrap items-start gap-4">
        <form action={toggleAssumption}><Metadata item={item} /><input type="hidden" name="enabled" value={item.enabled ? "false" : "true"} /><button className={linkButton}>{item.enabled ? "Disable" : "Enable"}</button></form>
        <form action={deleteAssumption}><Metadata item={item} /><button className={linkButton}>Remove</button></form>
        <details><summary className="cursor-pointer text-sm underline">Edit</summary>
          <form action={updateAssumption} className="mt-3 flex flex-wrap gap-2"><Metadata item={item} />
            <input name="name" required maxLength={120} defaultValue={item.name} aria-label={`Edit ${item.name} name`} className={field} />
            <input name="amount" required inputMode="decimal" defaultValue={formatInputAmount(item.amount_minor, item.currency_code)} aria-label={`Edit ${item.name} amount`} className={field + " w-28"} />
            <select name="cadence" defaultValue={item.cadence} aria-label={`Edit ${item.name} cadence`} className={field}>{cadenceOptions}</select>
            <input type="date" name="startsOn" required defaultValue={item.starts_on} aria-label={`Edit ${item.name} start date`} className={field} />
            <input type="date" name="endsOn" defaultValue={item.ends_on ?? ""} aria-label={`Edit ${item.name} end date`} className={field} />
            <button className={linkButton}>Save</button></form>
        </details>
      </div>
    </li>)}</ul>
    {!accounts.length ? <p className="text-muted-foreground">Add an account before creating a dated assumption.</p>
      : <form action={addAssumption} className="flex flex-wrap items-end gap-3 rounded-lg bg-muted/50 p-4"><input name="name" required aria-label="Assumption name" placeholder="Rent, salary…" maxLength={120} className={field} /><input name="amount" required inputMode="decimal" aria-label="Assumption amount" placeholder="-1200.00" className={field} /><select name="accountId" aria-label="Account" className={field}>{accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select><select name="cadence" aria-label="Cadence" defaultValue="monthly" className={field}>{cadenceOptions}</select><input type="date" name="startsOn" defaultValue={today} required aria-label="Start date" className={field} /><button className={button}>Add assumption</button></form>}
  </>;
}

import Link from "next/link";
import { randomUUID } from "node:crypto";
import { requireWorkspace } from "@/lib/auth";
import { createAccount } from "@/app/actions";
import { undoMoneyMetadata } from "./actions";
import { AccountForm } from "./account-form";

const types = ["checking", "savings", "cash", "credit", "investment", "wallet", "other"];
const inputClass = "rounded-md border bg-background px-3 py-2 text-sm";

export default async function AccountsPage() {
  const { supabase, workspace } = await requireWorkspace();
  const [{ data: accounts, error }, { data: history, error: historyError }] = await Promise.all([
    supabase.from("accounts").select("id,name,type,currency_code,version,archived_at").eq("workspace_id", workspace.id).order("created_at"),
    supabase.from("money_metadata_events").select("id,entity_type,entity_id,before,after,created_at,undone_at,undo_of").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(30),
  ]);
  if (error || historyError) throw new Error("Could not load accounts and edit history");
  const versions = new Map((accounts ?? []).map(account => [account.id, account.version]));
  const { data: views, error: viewsError } = await supabase.from("transaction_views").select("id,version").eq("workspace_id", workspace.id);
  if (viewsError) throw new Error("Could not load saved view versions");
  for (const view of views ?? []) versions.set(view.id, view.version);
  return <main className="mx-auto max-w-5xl space-y-6 p-6">
    <header className="space-y-2"><nav className="flex gap-4 text-sm"><Link href="/money/transactions">Transactions</Link><Link href="/money/recurring">Recurring</Link><Link href="/money/wealth">Wealth</Link></nav>
      <h1 className="text-2xl font-semibold">Accounts</h1><p className="text-sm text-muted-foreground">Archive an account when you stop using it. Its transactions, balance evidence and net worth history remain available. Release goal reservations and resolve pending debits first.</p></header>
    <section className="space-y-3" aria-label="Your accounts">
      {(accounts ?? []).map(account => <article className="rounded-xl border p-4" key={account.id}>
        <div className="mb-3 flex gap-3 text-sm"><strong>{account.name}</strong><span>{account.currency_code}</span>{account.archived_at ? <span>Archived</span> : null}</div>
        <AccountForm key={`${account.id}:${account.version}`} account={account} requestId={randomUUID()} />
        <p className="mt-2 text-xs text-muted-foreground">Currency is fixed after creation so recorded amounts keep their meaning.</p>
      </article>)}
    </section>
    <section className="rounded-xl border p-4"><h2 className="mb-3 font-semibold">Add account</h2><form action={createAccount} className="flex flex-wrap items-end gap-3">
      <label className="grid gap-1 text-sm">Name<input name="name" className={inputClass} maxLength={120} required /></label>
      <label className="grid gap-1 text-sm">Type<select name="type" className={inputClass}>{types.map(type => <option key={type}>{type}</option>)}</select></label>
      <label className="grid gap-1 text-sm">Currency<input name="currency" className={inputClass} defaultValue={workspace.display_currency} pattern="[A-Z]{3}" maxLength={3} required /></label><button className={inputClass}>Add account</button>
    </form></section>
    <section className="rounded-xl border p-4"><h2 className="font-semibold">Account and saved view history</h2><ul className="mt-3 space-y-3 text-sm">
      {(history ?? []).map(event => <li key={event.id} className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
        <span>{event.entity_type === "account" ? "Account" : "Saved view"}: {String(event.after?.name ?? event.before?.name ?? "Edit")} · {new Intl.DateTimeFormat(workspace.locale, { timeZone: workspace.timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(event.created_at))}{event.undone_at ? " · Undone" : event.undo_of ? " · Restored by undo" : ""}</span>
        {!event.undone_at && !event.undo_of && versions.has(event.entity_id) && !history?.some(later => later.entity_id === event.entity_id && !later.undone_at && !later.undo_of && later.after?.version > event.after?.version) ? <form action={undoMoneyMetadata}><input type="hidden" name="eventId" value={event.id} /><input type="hidden" name="version" value={versions.get(event.entity_id)} /><input type="hidden" name="requestId" value={randomUUID()} /><button className={inputClass}>Undo</button></form> : null}
      </li>)}
    </ul>{!history?.length ? <p className="mt-2 text-sm text-muted-foreground">Changes and their undo history appear here.</p> : null}</section>
  </main>;
}

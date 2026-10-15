import Link from "next/link";
import { randomUUID } from "node:crypto";
import { requireWorkspace } from "@/lib/auth";
import { createAccount } from "@/app/actions";
import { undoMoneyMetadata } from "./actions";
import { AccountForm } from "./account-form";

const types = ["checking", "savings", "cash", "credit", "investment", "wallet", "other"];
const inputClass = "min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm";

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
  return <main className="mx-auto w-full max-w-6xl space-y-8 px-4 py-8 sm:px-8 lg:py-10">
    <header><nav className="flex gap-4 text-sm text-muted-foreground"><Link className="hover:text-foreground" href="/money/transactions">Transactions</Link><Link className="hover:text-foreground" href="/money/recurring">Recurring</Link><Link className="hover:text-foreground" href="/money/wealth">Wealth</Link></nav>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl">Accounts</h1><p className="mt-2 text-sm text-muted-foreground">Archive an account when you stop using it; its history stays available.</p></header>
    <section className="space-y-4" aria-label="Your accounts">
      {!accounts?.length ? <p className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">No accounts yet. Add your first one below.</p> : null}
      {(accounts ?? []).map(account => <article className="rounded-xl border border-border bg-card p-6" key={account.id}>
        <div className="mb-4 flex items-center gap-3 text-sm"><strong>{account.name}</strong><span className="text-muted-foreground">{account.currency_code}</span>{account.archived_at ? <span className="rounded bg-muted px-2 py-0.5 text-xs">Archived</span> : null}</div>
        <AccountForm key={`${account.id}:${account.version}`} account={account} requestId={randomUUID()} />
      </article>)}
    </section>
    <section className="rounded-xl border border-border bg-card p-6"><h2 className="text-base font-semibold">Add account</h2><p className="mt-1 text-sm text-muted-foreground">Currency can’t be changed after the account is created.</p><form action={createAccount} className="mt-4 flex flex-wrap items-end gap-3">
      <label className="grid gap-1 text-sm">Name<input name="name" className={inputClass} maxLength={120} required /></label>
      <label className="grid gap-1 text-sm">Type<select name="type" className={inputClass}>{types.map(type => <option key={type} value={type}>{type[0].toUpperCase() + type.slice(1)}</option>)}</select></label>
      <label className="grid gap-1 text-sm">Currency<input name="currency" className={inputClass} defaultValue={workspace.display_currency} pattern="[A-Z]{3}" maxLength={3} required /></label><button className={inputClass}>Add account</button>
    </form></section>
    <section className="rounded-xl border border-border bg-card p-6"><h2 className="text-base font-semibold">Account and saved view history</h2><ul className="mt-4 space-y-3 text-sm">
      {(history ?? []).map(event => <li key={event.id} className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
        <span>{event.entity_type === "account" ? "Account" : "Saved view"}: {String(event.after?.name ?? event.before?.name ?? "Edit")} · {new Intl.DateTimeFormat(workspace.locale, { timeZone: workspace.timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(event.created_at))}{event.undone_at ? " · Undone" : event.undo_of ? " · Restored by undo" : ""}</span>
        {!event.undone_at && !event.undo_of && versions.has(event.entity_id) && !history?.some(later => later.entity_id === event.entity_id && !later.undone_at && !later.undo_of && later.after?.version > event.after?.version) ? <form action={undoMoneyMetadata}><input type="hidden" name="eventId" value={event.id} /><input type="hidden" name="version" value={versions.get(event.entity_id)} /><input type="hidden" name="requestId" value={randomUUID()} /><button className={inputClass}>Undo</button></form> : null}
      </li>)}
    </ul>{!history?.length ? <p className="mt-2 text-sm text-muted-foreground">Changes and their undo history appear here.</p> : null}</section>
  </main>;
}

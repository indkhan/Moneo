import Link from "next/link";
import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { History } from "lucide-react";
import { formatMoney } from "@/lib/finance/format";

type Change = { key: string; at: string; title: string; source: string; href: string };

// A recurring card asks a question ("X: €9.99 monthly, confirm as recurring?"); once accepted, History says what was done.
const decidedTitle = (title: string) => /, confirm as recurring\?$/.test(title) ? `Confirmed ${title.slice(0, title.lastIndexOf(": ")) || title} as recurring` : title;

// Memoized per request so Home can start these reads before its own data resolves.
export const loadHomeHistory = cache(async (db: SupabaseClient, workspaceId: string) => Promise.all([
  db.from("imports").select("id, filename, new_rows, created_at").eq("workspace_id", workspaceId).eq("status", "completed").order("created_at", { ascending: false }).limit(4),
  db.from("balance_snapshots").select("id, account_id, amount_minor::text, currency_code, created_at").eq("workspace_id", workspaceId).not("actor_id", "is", null).is("undone_at", null).order("created_at", { ascending: false }).limit(4),
  db.from("wealth_events").select("id, after, created_at").eq("workspace_id", workspaceId).is("undone_at", null).order("created_at", { ascending: false }).limit(4),
  db.from("agent_proposals").select("id, run_id, title, result, decided_at").eq("workspace_id", workspaceId).eq("status", "accepted").order("decided_at", { ascending: false }).limit(4),
]));

/**
 * Home's History strip: the latest changes from imports, manual balances, wealth edits and accepted agent proposals.
 * Undo opens the page that owns each change, so its existing preview and version checks still apply.
 */
export async function HomeHistory({ db, workspaceId, locale, timeZone, names }: { db: SupabaseClient; workspaceId: string; locale: string; timeZone: string; names: Map<string, string> }) {
  const [imports, balances, wealth, agents] = await loadHomeHistory(db, workspaceId);
  const changes: Change[] = [
    ...(imports.data ?? []).map(row => ({ key: `import:${row.id}`, at: row.created_at, title: `Imported ${row.filename} · ${row.new_rows} rows`, source: "import", href: "/import" })),
    ...(balances.data ?? []).map(row => ({ key: `balance:${row.id}`, at: row.created_at, title: `Set ${names.get(row.account_id) ?? "account"} balance to ${formatMoney(row.amount_minor, row.currency_code, locale)}`, source: "manual", href: "/money/accounts" })),
    ...(wealth.data ?? []).map(row => ({ key: `wealth:${row.id}`, at: row.created_at, title: `${(row.after as { removed_at?: string | null }).removed_at ? "Removed" : "Updated"} ${(row.after as { name?: string }).name ?? "a valuation"}`, source: "manual", href: "/money/wealth" })),
    ...(agents.data ?? []).filter(row => row.decided_at).map(row => ({ key: `agent:${row.id}`, at: row.decided_at!, title: decidedTitle(row.title), source: "agent", href: (row.result as { href?: string } | null)?.href ?? `/ai/agents/${row.run_id}` })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 4);
  if (!changes.length) return null;
  const when = (iso: string) => new Intl.DateTimeFormat(locale, { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(iso));
  return <section aria-labelledby="home-history" className="grid overflow-hidden rounded-xl border border-border bg-card sm:grid-cols-[repeat(auto-fit,minmax(12rem,1fr))]">
    <div className="p-5"><h2 id="home-history" className="flex items-center gap-2 text-sm font-medium"><History className="size-4" aria-hidden="true" />History</h2><p className="mt-1 text-xs text-muted-foreground">Every change can be undone.</p></div>
    {changes.map(change => <article key={change.key} className="flex flex-col justify-between gap-3 border-t border-border p-5 sm:border-l sm:border-t-0">
      <h3 className="line-clamp-2 text-[13px] font-medium">{change.title}</h3>
      <div className="flex items-center justify-between gap-2"><p className="truncate font-mono text-[11px] text-subtle">{change.source} · {when(change.at)}</p>
        <Link href={change.href} className="shrink-0 rounded-lg border border-input px-2.5 py-1 text-xs hover:bg-muted">Undo</Link></div>
    </article>)}
  </section>;
}

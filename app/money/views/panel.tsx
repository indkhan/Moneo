import Link from "next/link";
import { randomUUID } from "node:crypto";
import { deleteTransactionView, renameTransactionView, saveTransactionView, updateTransactionViewFilters } from "./actions";
import type { SaveInput } from "./validate";

type SavedViewRow = { id: string; name: string; created_at: string; version: number };

/**
 * Saved-views side rail. Open links carry only the opaque view UUID
 * (?view=<uuid>); the filter JSON stays workspace-scoped on the server and is
 * applied in app/money/transactions/page.tsx.
 */
export function SavedViewsPanel({ views, activeViewId, activeViewName, saveDefaults, disableSave }: {
  views: SavedViewRow[];
  activeViewId: string | null;
  activeViewName: string | null;
  saveDefaults: SaveInput;
  /** Hides save/update when the open view's scope is invalid, so a broken
   * scope can never be re-saved broader. Rename/delete stay available. */
  disableSave?: boolean;
}) {
  const filterInputs = Object.entries(saveDefaults).map(([name, value]) => value !== undefined ? <input key={name} type="hidden" name={name} value={value} /> : null);
  const identity = (view: SavedViewRow) => <><input type="hidden" name="viewId" value={view.id} /><input type="hidden" name="version" value={view.version} /><input type="hidden" name="requestId" value={randomUUID()} /></>;
  return <section aria-label="Saved views" className="space-y-3 text-sm">
    <div className="flex items-baseline justify-between"><h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Saved views</h2>
      {activeViewId ? <Link className="text-xs text-muted-foreground underline" href="/money/transactions">Clear</Link> : null}</div>
    <ul className="space-y-0.5">
      <li><Link href="/money/transactions" className={`block rounded-lg px-2.5 py-1.5 ${activeViewId ? "hover:bg-muted" : "bg-muted font-medium"}`}>All transactions</Link></li>
      {views.map(view => <li key={view.id} className="group">
        <div className={`flex items-center justify-between rounded-lg ${view.id === activeViewId ? "bg-muted font-medium" : "hover:bg-muted"}`}>
          <Link className="block min-w-0 flex-1 truncate px-2.5 py-1.5" href={`/money/transactions?view=${view.id}`} aria-current={view.id === activeViewId ? "page" : undefined}>{view.name}</Link>
        </div>
        <details className="px-2.5 text-xs text-muted-foreground">
          <summary className="cursor-pointer py-0.5 hover:text-foreground">Manage {view.name}</summary>
          <div className="space-y-2 py-2">
            <form action={renameTransactionView} className="flex gap-1.5">{identity(view)}
              <input name="name" defaultValue={view.name} aria-label={`Rename saved view ${view.name}`} maxLength={80} required className="min-w-0 flex-1 rounded border border-border bg-card px-2 py-1 text-foreground" />
              <button className="rounded border border-border px-2 hover:bg-muted">Rename</button>
            </form>
            {!disableSave ? <form action={updateTransactionViewFilters}>{identity(view)}{filterInputs}
              <button aria-label={`Update filters for saved view ${view.name}`} className="underline hover:text-foreground">Use current filters</button>
            </form> : null}
            <form action={deleteTransactionView}>{identity(view)}
              <button aria-label={`Delete saved view ${view.name}`} className="underline hover:text-red-700 dark:hover:text-red-300">Delete</button>
            </form>
          </div>
        </details>
      </li>)}
    </ul>
    {!views.length ? <p className="px-2.5 text-xs text-muted-foreground">No saved views yet. Filter the ledger, then save it here.</p> : null}
    {activeViewId && activeViewName ? <p className="px-2.5 text-xs text-muted-foreground">Showing <strong className="text-foreground">{activeViewName}</strong>.</p> : null}
    {!disableSave ? <form action={saveTransactionView} className="space-y-1.5 border-t border-border pt-3">{filterInputs}
      <input name="name" required maxLength={80} placeholder="e.g. Restaurants over €20" aria-label="Saved view name" className="w-full rounded-lg border border-border bg-card px-2.5 py-1.5" />
      <button className="w-full rounded-lg border border-border px-3 py-1.5 font-medium hover:bg-muted">Save view</button>
    </form> : null}
    <Link className="block px-2.5 text-xs text-muted-foreground underline" href="/money/accounts">Undo view changes</Link>
  </section>;
}

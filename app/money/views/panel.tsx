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
  const tab = (active: boolean) => `flex h-11 items-center rounded-[10px] px-3.5 lg:h-9 text-[13px] ${active ? "bg-foreground font-medium text-background" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`;
  return <section aria-label="Saved views" className="space-y-2 text-sm">
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border pb-3">
      <h2 className="sr-only">Saved views</h2>
      <Link href="/money/transactions" className={tab(!activeViewId)}>All transactions</Link>
      {views.map(view => <Link key={view.id} className={`${tab(view.id === activeViewId)} max-w-56 truncate`} href={`/money/transactions?view=${view.id}`} aria-current={view.id === activeViewId ? "page" : undefined}>{view.name}</Link>)}
      {!disableSave ? <form action={saveTransactionView} className="flex w-full items-center gap-1.5 sm:ml-auto sm:w-auto">{filterInputs}
        <input name="name" required maxLength={80} placeholder="Name this view, e.g. Restaurants over €20" aria-label="Saved view name" className="h-9 min-w-0 flex-1 rounded-[10px] border border-dashed sm:w-64 sm:flex-none border-input bg-transparent px-3 text-[13px] placeholder:text-muted-foreground" />
        <button className="h-9 shrink-0 whitespace-nowrap rounded-[10px] border border-input px-3 text-[13px] hover:bg-muted">Save view</button>
      </form> : null}
    </div>
    <div className="flex flex-wrap items-start gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {!views.length ? <p>No saved views yet. Filter the ledger, then save it here.</p> : null}
      {activeViewId && activeViewName ? <p>Showing <strong className="text-foreground">{activeViewName}</strong>. <Link className="underline" href="/money/transactions">Clear</Link></p> : null}
      {views.map(view => <details key={view.id}>
        <summary className="cursor-pointer py-0.5 hover:text-foreground">Manage {view.name}</summary>
        <div className="mt-1 space-y-2 rounded-xl border border-border bg-card p-3">
          <form action={renameTransactionView} className="flex gap-1.5">{identity(view)}
            <input name="name" defaultValue={view.name} aria-label={`Rename saved view ${view.name}`} maxLength={80} required className="min-w-0 flex-1 rounded-md border border-input bg-card px-2 py-1 text-foreground" />
            <button className="rounded-md border border-input px-2 hover:bg-muted">Rename</button>
          </form>
          {!disableSave ? <form action={updateTransactionViewFilters}>{identity(view)}{filterInputs}
            <button aria-label={`Update filters for saved view ${view.name}`} className="underline hover:text-foreground">Use current filters</button>
          </form> : null}
          <form action={deleteTransactionView}>{identity(view)}
            <button aria-label={`Delete saved view ${view.name}`} className="underline hover:text-danger">Delete</button>
          </form>
        </div>
      </details>)}
      <Link className="ml-auto underline" href="/money/accounts">Undo view changes</Link>
    </div>
  </section>;
}

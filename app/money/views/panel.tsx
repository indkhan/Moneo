import Link from "next/link";
import { randomUUID } from "node:crypto";
import { deleteTransactionView, renameTransactionView, saveTransactionView, updateTransactionViewFilters } from "./actions";
import type { SaveInput } from "./validate";

export type SavedViewRow = { id: string; name: string; created_at: string; version: number };

/**
 * Save / list / open / delete for transaction views.
 * Open links carry only the opaque view UUID (?view=<uuid>); the filter
 * JSON stays workspace-scoped on the server and is applied in
 * app/money/transactions/page.tsx.
 */
export function SavedViewsPanel({
  views,
  activeViewId,
  activeViewName,
  saveDefaults,
}: {
  views: SavedViewRow[];
  activeViewId: string | null;
  activeViewName: string | null;
  saveDefaults: SaveInput;
}) {
  return (
    <section aria-label="Saved views" className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-sm font-semibold">Saved views</h2>
      {activeViewId ? (
        <p className="mt-2 text-sm">
          Open: <strong>{activeViewName ?? "Saved view"}</strong>{" "}
          <Link className="underline" href="/money/transactions">
            Clear
          </Link>
        </p>
      ) : null}
      {views.length ? (
        <ul className="mt-3 flex flex-wrap gap-2 text-xs">
          {views.map((view) => (
            <li key={view.id} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <Link className="font-medium text-blue-700 hover:underline" href={`/money/transactions?view=${view.id}`}>
                {view.name}
              </Link>
              {view.id === activeViewId ? <span className="text-muted-foreground">(open)</span> : null}
              <form action={deleteTransactionView}>
                <input type="hidden" name="viewId" value={view.id} />
                <input type="hidden" name="version" value={view.version} />
                <input type="hidden" name="requestId" value={randomUUID()} />
                <button aria-label={`Delete saved view ${view.name}`} className="text-slate-500 hover:text-red-700 hover:underline">
                  Delete
                </button>
              </form>
              <form action={updateTransactionViewFilters}>
                <input type="hidden" name="viewId" value={view.id} /><input type="hidden" name="version" value={view.version} /><input type="hidden" name="requestId" value={randomUUID()} />
                {Object.entries(saveDefaults).map(([name, value]) => value !== undefined ? <input key={name} type="hidden" name={name} value={value} /> : null)}
                <button aria-label={`Update filters for saved view ${view.name}`}>Use current filters</button>
              </form>
              <form action={renameTransactionView} className="flex gap-2">
                <input type="hidden" name="viewId" value={view.id} /><input type="hidden" name="version" value={view.version} /><input type="hidden" name="requestId" value={randomUUID()} />
                <input name="name" defaultValue={view.name} aria-label={`Rename saved view ${view.name}`} maxLength={80} required className="max-w-40 rounded border p-1" />
                <button>Rename</button>
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">No saved views yet.</p>
      )}
      <form action={saveTransactionView} className="mt-4 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-4">
        <label className="block text-sm">
          Save current filters as
          <input
            name="name"
            required
            maxLength={80}
            placeholder="e.g. Restaurants over €20"
            aria-label="Saved view name"
            className="ml-2 rounded-lg border border-slate-200 bg-white p-2 text-xs"
          />
        </label>
        {saveDefaults.q !== undefined ? <input type="hidden" name="q" value={saveDefaults.q} /> : null}
        {saveDefaults.from !== undefined ? <input type="hidden" name="from" value={saveDefaults.from} /> : null}
        {saveDefaults.to !== undefined ? <input type="hidden" name="to" value={saveDefaults.to} /> : null}
        {saveDefaults.account !== undefined ? <input type="hidden" name="account" value={saveDefaults.account} /> : null}
        {saveDefaults.status !== undefined ? <input type="hidden" name="status" value={saveDefaults.status} /> : null}
        {saveDefaults.kind !== undefined ? <input type="hidden" name="kind" value={saveDefaults.kind} /> : null}
        {saveDefaults.direction !== undefined ? (
          <input type="hidden" name="direction" value={saveDefaults.direction} />
        ) : null}
        {saveDefaults.category !== undefined ? (
          <input type="hidden" name="category" value={saveDefaults.category} />
        ) : null}
        {saveDefaults.merchant !== undefined ? (
          <input type="hidden" name="merchant" value={saveDefaults.merchant} />
        ) : null}
        {saveDefaults.minAmount !== undefined ? (
          <input type="hidden" name="minAmount" value={saveDefaults.minAmount} />
        ) : null}
        {saveDefaults.maxAmount !== undefined ? (
          <input type="hidden" name="maxAmount" value={saveDefaults.maxAmount} />
        ) : null}
        {saveDefaults.sort !== undefined ? <input type="hidden" name="sort" value={saveDefaults.sort} /> : null}
        <button className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-medium hover:bg-slate-50">Save view</button>
      </form>
      <p className="mt-2 text-xs text-muted-foreground">
        Saved-view links contain only an opaque id; search terms and account ids stay server-side.
        {" "}<Link className="underline" href="/money/accounts">View edit history and undo</Link>
      </p>
    </section>
  );
}

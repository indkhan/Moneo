import Link from "next/link";
import { deleteTransactionView, saveTransactionView } from "./actions";
import type { SaveInput } from "./validate";

export type SavedViewRow = { id: string; name: string; created_at: string };

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
    <section aria-label="Saved views" className="mt-8 rounded border p-4">
      <h2 className="font-medium">Saved views</h2>
      {activeViewId ? (
        <p className="mt-2 text-sm">
          Open: <strong>{activeViewName ?? "Saved view"}</strong>{" "}
          <Link className="underline" href="/money/transactions">
            Clear
          </Link>
        </p>
      ) : null}
      {views.length ? (
        <ul className="mt-3 space-y-2 text-sm">
          {views.map((view) => (
            <li key={view.id} className="flex items-center gap-3">
              <Link className="underline" href={`/money/transactions?view=${view.id}`}>
                {view.name}
              </Link>
              {view.id === activeViewId ? <span className="text-muted-foreground">(open)</span> : null}
              <form action={deleteTransactionView}>
                <input type="hidden" name="viewId" value={view.id} />
                <button aria-label={`Delete saved view ${view.name}`} className="underline">
                  Delete
                </button>
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">No saved views yet.</p>
      )}
      <form action={saveTransactionView} className="mt-4 flex flex-wrap items-end gap-2">
        <label className="block text-sm">
          Save current filters as
          <input
            name="name"
            required
            maxLength={80}
            placeholder="e.g. Restaurants over €20"
            aria-label="Saved view name"
            className="ml-2 rounded border p-2"
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
        <button className="rounded border px-4 py-2 text-sm">Save view</button>
      </form>
      <p className="mt-2 text-xs text-muted-foreground">
        Saved-view links contain only an opaque id; search terms and account ids stay server-side.
      </p>
    </section>
  );
}

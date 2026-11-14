import { SafeForm } from "@/components/safe-form";
import type { MemoryEntry } from "@/lib/organize/surfaces";
import { editMemorySafely, removeMemorySafely } from "./actions";
import { Action, Empty, Pick, card, field, primary } from "./parts";

type Options = { id: string; name: string }[];
type Created = { id: string; name: string; owner_touched: boolean }[];
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function Memory({ entries, categories, merchants, aiCategories, aiMerchants }: { entries: MemoryEntry[]; categories: Options; merchants: Options; aiCategories: Created; aiMerchants: Created }) {
  const name = (id: string | null, list: Options) => (id && list.find(item => item.id === id)?.name) || null;
  const created = (label: string, items: Created) => items.length > 0 && <div>
    <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</h3>
    <ul className="mt-1 flex flex-wrap gap-1.5 text-sm">{items.map(item => <li key={item.id} className="rounded-full border border-border px-2.5 py-1">{item.name}{item.owner_touched && <span className="text-muted-foreground"> · you use it</span>}</li>)}</ul>
  </div>;
  return <div className="space-y-6">
    {entries.length === 0 ? <Empty>No payees remembered yet. When you answer a question, what you said is kept here and used for every future payment from them.</Empty>
      : <ul aria-label="Remembered payees" className="space-y-3">{entries.map(entry => {
        const summary = [name(entry.categoryId, categories), name(entry.merchantId, merchants), entry.purpose].filter(Boolean).join(" · ");
        return <li key={entry.id}><section aria-label={`Memory for ${entry.identityName}`} className={card}>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="font-medium">{entry.identityName}</h2>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{entry.source === "owner" ? "You confirmed" : "Organizer's note"}</span>
          </div>
          <p className="mt-1 text-sm">{summary || "Nothing set"}</p>
          <p className="mt-1 text-xs text-muted-foreground">Covers {plural(entry.covered, "row", "rows")}{entry.examples.length > 0 && `: ${entry.examples.join(", ")}`}</p>
          <details className="mt-3">
            <summary className="min-h-9 cursor-pointer text-sm underline">Edit</summary>
            <SafeForm action={editMemorySafely} className="mt-2 flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <input type="hidden" name="identity" value={entry.identityId} />
              <Pick name="category" label={`Category for ${entry.identityName}`} options={categories} empty="No category" value={entry.categoryId} />
              <Pick name="merchant" label={`Merchant for ${entry.identityName}`} options={merchants} empty="No merchant" value={entry.merchantId} />
              <input name="purpose" aria-label={`What ${entry.identityName} is for`} defaultValue={entry.purpose ?? ""} maxLength={200} placeholder="What it is for (optional)" className={field} />
              <button aria-label={`Save memory for ${entry.identityName}`} className={primary}>Save</button>
            </SafeForm>
          </details>
          <div className="mt-2"><Action action={removeMemorySafely} fields={[["memory", entry.id]]} label="Remove" name={`Remove memory for ${entry.identityName}`} /></div>
        </section></li>;
      })}</ul>}
    {entries.length > 0 && <p className="text-xs text-muted-foreground">Removing a payee stops future payments being labelled from it. Rows already labelled keep their labels and can still be undone.</p>}
    {(aiCategories.length > 0 || aiMerchants.length > 0) && <section aria-label="Made by the organizer" className="space-y-3">
      <h2 className="text-sm font-medium">Made by the organizer</h2>
      {created("Categories", aiCategories)}{created("Merchants", aiMerchants)}
    </section>}
  </div>;
}

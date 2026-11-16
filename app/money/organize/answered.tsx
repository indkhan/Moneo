import type { Answered } from "@/lib/organize/surfaces";
import { undoAnswerSafely } from "./actions";
import { Action } from "./parts";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function RecentlyAnswered({ answered }: { answered: Answered[] }) {
  if (!answered.length) return null;
  return <section aria-label="Recently answered" className="space-y-2">
    <h2 className="text-sm font-medium">Recently answered</h2>
    <ul className="divide-y divide-border rounded-xl border border-border bg-card text-sm">{answered.map(item => <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
      <span className="min-w-0 flex-1">{item.identityName ?? item.question}<span className="text-muted-foreground"> · {plural(item.applied, "row", "rows")} labelled</span></span>
      <Action action={undoAnswerSafely} fields={[["batch", item.batchId]]} label="Undo" name={`Undo the answer for ${item.identityName ?? item.question}`} />
    </li>)}</ul>
    <p className="text-xs text-muted-foreground">Undo takes back the labels. What you said the payee is stays in Memory until you remove it.</p>
  </section>;
}

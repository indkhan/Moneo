import { SafeForm } from "@/components/safe-form";
import { resolveRepeatsSafely } from "./repeats-action";

/** One press for rows a bank re-listed. They stay on record, each with its own undo under "Decided". */
export function ResolveRepeats({ count }: { count: number }) {
  return <SafeForm action={resolveRepeatsSafely} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-4 text-sm">
    <p className="min-w-0 flex-1 basis-64"><span className="font-medium">{count} waiting {count === 1 ? "row repeats" : "rows repeat"} what your ledger already has.</span> <span className="text-muted-foreground">The bank listed {count === 1 ? "it" : "them"} again with no transaction ID, and the counts match, so nothing is posted twice. The rows stay on record, and you can undo each one.</span></p>
    <button className="min-h-11 rounded-lg border border-input px-3 text-sm font-medium hover:bg-muted">Resolve {count === 1 ? "this repeat" : `${count} repeats`}</button>
  </SafeForm>;
}

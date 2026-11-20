"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { confirmMemory, loadMemoryStatuses, undoMemory } from "@/lib/ai/memory-actions";
import { MEMORY_KIND_LABELS, readMemoryNote, type NotedMemory } from "@/lib/ai/memory-note";

const button = "min-h-8 rounded-md border border-border px-2.5 text-xs hover:bg-muted disabled:opacity-50";
const statusesUnavailableShowNoActions = (): Record<string, string> => ({});

function Row({ memory, prefix, children }: { memory: NotedMemory; prefix?: string; children?: React.ReactNode }) {
  return <li className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1">
    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px]">{MEMORY_KIND_LABELS[memory.kind]}</span>
    <span className="min-w-0 flex-1 text-foreground">{prefix}{memory.statement}</span>
    {children}
  </li>;
}

export function MemoryNoteView({ source }: { source: string }) {
  const note = useMemo(() => readMemoryNote(source), [source]);
  const ids = note ? [...new Set([...note.saved, ...note.ended].map(memory => memory.id))].join(",") : "";
  const [statuses, setStatuses] = useState<Record<string, string>>();
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  useEffect(() => {
    if (ids) loadMemoryStatuses(ids.split(",")).then(setStatuses, () => setStatuses(statusesUnavailableShowNoActions()));
  }, [ids]);
  if (!note) return null;
  const act = (id: string, run: (id: string) => Promise<void>, next: string) => start(async () => {
    setError(undefined);
    try { await run(id); setStatuses(current => ({ ...current, [id]: next })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "That did not work"); }
  });
  const status = (id: string) => statuses?.[id];
  const asked = note.saved.filter(memory => status(memory.id) === "suggested");
  const kept = note.saved.filter(memory => status(memory.id) !== "suggested" && status(memory.id) !== "dismissed");
  const changed = kept.length + note.ended.length;
  return <div className="my-3 space-y-2 text-xs text-muted-foreground" aria-label="Memory">
    {asked.map(memory => <div key={memory.id} role="group" aria-label="Save this memory?" className="rounded-lg border border-border bg-card p-3">
      <p className="mb-1 font-medium text-foreground">Save this?</p>
      <ul><Row memory={memory}>
        <button className={button} disabled={pending} onClick={() => act(memory.id, confirmMemory, "active")}>Save</button>
        <button className={button} disabled={pending} onClick={() => act(memory.id, undoMemory, "dismissed")}>Not now</button>
      </Row></ul>
    </div>)}
    {changed > 0 && <details>
      <summary className="cursor-pointer">Memory updated</summary>
      <ul className="mt-1">
        {kept.map(memory => <Row key={memory.id} memory={memory}>
          {status(memory.id) === "active" ? <button className={button} disabled={pending} onClick={() => act(memory.id, undoMemory, "undone")}>Undo</button>
            : status(memory.id) === "undone" || (statuses && !status(memory.id)) ? <span>Undone</span> : statuses ? <span>Changed since</span> : null}
        </Row>)}
        {note.ended.map(memory => <Row key={memory.id} memory={memory} prefix="No longer true: ">
          {status(memory.id) === "ended" ? <button className={button} disabled={pending} onClick={() => act(memory.id, undoMemory, "active")}>Undo</button>
            : statuses ? <span>Undone</span> : null}
        </Row>)}
      </ul>
    </details>}
    {note.used.length > 0 && <details>
      <summary className="cursor-pointer">Used {note.used.length} {note.used.length === 1 ? "memory" : "memories"}</summary>
      <ul className="mt-1">{note.used.map(memory => <Row key={memory.id} memory={memory} />)}</ul>
    </details>}
    {(changed > 0 || note.used.length > 0) && <Link href="/ai/memory" className="inline-block underline">What Moneo knows about you</Link>}
    {error && <p role="alert" className="text-danger">{error}</p>}
  </div>;
}

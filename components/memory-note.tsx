"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { confirmMemory, declineMemory, loadNotedMemories, undoMemory, type NotedMemory } from "@/lib/ai/memory-actions";
import { MEMORY_KIND_LABELS, readMemoryNote } from "@/lib/ai/memory-note";

const button = "min-h-8 rounded-md border border-border px-2.5 text-xs hover:bg-muted disabled:opacity-50";
const UNAVAILABLE = "unavailable" as const;

function Row({ memory, prefix, children }: { memory: NotedMemory; prefix?: string; children?: React.ReactNode }) {
  return <li className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1">
    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px]">{MEMORY_KIND_LABELS[memory.kind]}</span>
    <span className="min-w-0 flex-1 text-foreground">{prefix}{memory.statement}</span>
    {children}
  </li>;
}

export function MemoryNoteView({ source }: { source: string }) {
  const note = useMemo(() => readMemoryNote(source), [source]);
  const ids = note ? [...new Set([...note.saved, ...note.ended, ...note.used])].join(",") : "";
  const [memories, setMemories] = useState<Record<string, NotedMemory> | typeof UNAVAILABLE>();
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  useEffect(() => {
    if (ids) loadNotedMemories(ids.split(",")).then(setMemories, () => setMemories(UNAVAILABLE));
  }, [ids]);
  if (!note || !memories) return null;
  if (memories === UNAVAILABLE) return <p className="my-3 text-xs text-muted-foreground">Memory changed in this answer. <Link href="/ai/memory" className="underline">See what Moneo knows about you</Link></p>;
  const act = (memory: NotedMemory, run: (id: string) => Promise<void>, status: string) => start(async () => {
    setError(undefined);
    try { await run(memory.id); setMemories(current => current === UNAVAILABLE ? current : { ...current, [memory.id]: { ...memory, status } }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "That did not work"); }
  });
  const known = (list: string[]) => list.flatMap(id => memories[id] ? [memories[id]] : []);
  const removed = note.saved.length + note.ended.length - known(note.saved).length - known(note.ended).length;
  const asked = known(note.saved).filter(memory => memory.status === "suggested");
  const kept = known(note.saved).filter(memory => memory.status !== "suggested" && memory.status !== "declined");
  const ended = known(note.ended);
  const used = known(note.used);
  const changed = kept.length + ended.length + removed;
  return <div className="my-3 space-y-2 text-xs text-muted-foreground" aria-label="Memory">
    {asked.map(memory => <div key={memory.id} role="group" aria-label="Save this memory?" className="rounded-lg border border-border bg-card p-3">
      <p className="mb-1 font-medium text-foreground">Save this?</p>
      <ul><Row memory={memory}>
        <button className={button} disabled={pending} onClick={() => act(memory, confirmMemory, "active")}>Save</button>
        <button className={button} disabled={pending} onClick={() => act(memory, declineMemory, "declined")}>Not now</button>
      </Row></ul>
    </div>)}
    {changed > 0 && <details>
      <summary className="cursor-pointer">Memory updated</summary>
      <ul className="mt-1">
        {kept.map(memory => <Row key={memory.id} memory={memory}>
          {memory.status === "active" ? <button className={button} disabled={pending} onClick={() => act(memory, undoMemory, "undone")}>Undo</button>
            : <span>{memory.status === "undone" ? "Undone" : "Changed since"}</span>}
        </Row>)}
        {ended.map(memory => <Row key={memory.id} memory={memory} prefix="No longer true: ">
          {memory.status === "ended" ? <button className={button} disabled={pending} onClick={() => act(memory, undoMemory, "active")}>Undo</button> : <span>Undone</span>}
        </Row>)}
        {removed > 0 && <li className="py-1">{removed === 1 ? "1 memory from this answer was" : `${removed} memories from this answer were`} undone or forgotten since.</li>}
      </ul>
    </details>}
    {used.length > 0 && <details>
      <summary className="cursor-pointer">Used {used.length} {used.length === 1 ? "memory" : "memories"}</summary>
      <ul className="mt-1">{used.map(memory => <Row key={memory.id} memory={memory} />)}</ul>
    </details>}
    {(changed > 0 || used.length > 0) && <Link href="/ai/memory" className="inline-block underline">What Moneo knows about you</Link>}
    {error && <p role="alert" className="text-danger">{error}</p>}
  </div>;
}

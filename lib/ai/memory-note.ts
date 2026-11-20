import { z } from "zod";

export const MEMORY_KINDS = ["pledge", "plan", "fact", "explanation", "preference"] as const;
export type MemoryKind = typeof MEMORY_KINDS[number];
export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = { pledge: "Pledge", plan: "Plan", fact: "Fact", explanation: "Explanation", preference: "Preference" };

const MAX_NOTED = 20;
const ids = z.array(z.uuid()).max(MAX_NOTED);
export const memoryNoteSchema = z.object({ saved: ids, ended: ids, used: ids }).strict();
export type MemoryNote = z.infer<typeof memoryNoteSchema>;

export const MEMORY_NOTE_FENCE = "moneo-memory";
export function memoryNoteBlock(note: MemoryNote) {
  const noted = (list: string[]) => [...new Set(list)].slice(0, MAX_NOTED);
  const saved = noted(note.saved), ended = noted(note.ended), used = noted(note.used.filter(id => !note.saved.includes(id)));
  if (!saved.length && !ended.length && !used.length) return null;
  return "```" + MEMORY_NOTE_FENCE + "\n" + JSON.stringify({ saved, ended, used }) + "\n```";
}

const unreadableNoteShowsNothing = () => null;
export function readMemoryNote(source: string): MemoryNote | null {
  try { return memoryNoteSchema.safeParse(JSON.parse(source)).data ?? null; } catch { return unreadableNoteShowsNothing(); }
}

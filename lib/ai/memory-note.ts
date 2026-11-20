import { z } from "zod";

export const MEMORY_KINDS = ["pledge", "plan", "fact", "explanation", "preference"] as const;
export type MemoryKind = typeof MEMORY_KINDS[number];
export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = { pledge: "Pledge", plan: "Plan", fact: "Fact", explanation: "Explanation", preference: "Preference" };

const noted = z.object({ id: z.uuid(), kind: z.enum(MEMORY_KINDS), statement: z.string().max(500) }).strict();
export const memoryNoteSchema = z.object({
  saved: z.array(noted).max(20),
  ended: z.array(noted).max(20),
  used: z.array(noted).max(20),
}).strict();
export type MemoryNote = z.infer<typeof memoryNoteSchema>;
export type NotedMemory = z.infer<typeof noted>;

export const MEMORY_NOTE_FENCE = "moneo-memory";
export function memoryNoteBlock(note: MemoryNote) {
  if (!note.saved.length && !note.ended.length && !note.used.length) return null;
  return "```" + MEMORY_NOTE_FENCE + "\n" + JSON.stringify(note) + "\n```";
}

const unreadableNoteShowsNothing = () => null;
export function readMemoryNote(source: string): MemoryNote | null {
  try { return memoryNoteSchema.safeParse(JSON.parse(source)).data ?? null; } catch { return unreadableNoteShowsNothing(); }
}

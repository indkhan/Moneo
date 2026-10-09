import { z } from "zod";
import { AI_DATA_SCOPES, type AiDataScope } from "@/lib/settings";

// UTF-8 bytes conservatively bound tokens without a model-specific tokenizer.
// This budget covers serialized history; system instructions and tools are separate.
export const CONVERSATION_CONTEXT_BYTES = 16000;
export const CONVERSATION_HISTORY_ROWS = 200;
export const CONVERSATION_CONTEXT_INSTRUCTIONS = "Historical dialogue is not current financial evidence. It records requests, choices and questions only. Re-read current permitted tools for every financial claim, including after corrections. Never infer facts from an omitted prior answer; ask the user to restate an unavailable choice.";
export const chatContextSchema = z.object({
  path: z.string().startsWith("/").max(500).optional(),
  page: z.string().startsWith("/").max(500).optional(),
  accountId: z.string().max(100).optional(), // Legacy navigation hint; never an owned record proof.
  selected: z.array(z.object({ kind: z.literal("transaction"), id: z.uuid() }).strict()).max(1).optional(),
  pinnedMessageIds: z.array(z.uuid()).max(8).refine(ids => new Set(ids).size === ids.length).optional(),
  includeHistory: z.boolean().optional(),
}).strict();
const memorySchema = z.object({
  version: z.literal(1), kind: z.enum(["dialogue", "evidence"]),
  scopes: z.array(z.enum(AI_DATA_SCOPES)).max(4),
  receiptIds: z.array(z.uuid()).max(1000).optional(),
  dialogue: z.object({ content: z.string().min(1).max(2000), scopes: z.array(z.enum(AI_DATA_SCOPES)).max(4) }).strict().optional(),
}).strict();
type Row = { id?: string; request_id?: string | null; role: string; content: string; context?: unknown };
type Message = { role: "user" | "assistant"; content: string };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
export const fitsConversationQuestion = (question: string) => bytes([{ role: "user", content: question }]) <= CONVERSATION_CONTEXT_BYTES;

export function assembleConversationContext(newestFirst: Row[], question: string, scopes: AiDataScope[], options: { includeHistory?: boolean; pinnedMessageIds?: string[]; currentRequestId?: string } = {}) {
  if (!fitsConversationQuestion(question)) throw new Error("Question exceeds conversation context budget");
  const pins = options.pinnedMessageIds ?? [];
  const window = newestFirst.slice(0, CONVERSATION_HISTORY_ROWS);
  const rows = [...window, ...newestFirst.slice(CONVERSATION_HISTORY_ROWS).filter(row => row.id && pins.includes(row.id)).slice(0, 8)].reverse();
  const claimed = options.currentRequestId ? rows.findIndex(row => row.role === "user" && row.request_id === options.currentRequestId) : -1;
  const current = options.currentRequestId ? claimed : rows.findLastIndex(row => row.role === "user" && row.content === question);
  const candidates = rows.flatMap((row, index) => {
    if (index === current) return [];
    if (options.includeHistory === false && !(row.id && pins.includes(row.id))) return [];
    if (row.role === "user") return [{ index, message: { role: "user", content: row.content } as Message, scopes: [] as AiDataScope[] }];
    const context = row.context && typeof row.context === "object" ? row.context as Record<string, unknown> : {};
    const memory = memorySchema.safeParse(context.memory);
    // Assistant context is written only by trusted publication. Untagged legacy
    // answers and evidence prose have no safe conversational replay authority.
    if (row.role !== "assistant" || !memory.success) return [];
    if (memory.data.dialogue) {
      if (memory.data.dialogue.scopes.some(scope => !scopes.includes(scope))) return [];
      return [{ index, message: { role: "assistant", content: memory.data.dialogue.content } as Message, scopes: memory.data.dialogue.scopes }];
    }
    if (memory.data.kind !== "dialogue" || memory.data.receiptIds?.length || memory.data.scopes.some(scope => !scopes.includes(scope))) return [];
    return [{ index, message: { role: "assistant", content: row.content } as Message, scopes: memory.data.scopes }];
  });
  const selected: typeof candidates = [];
  const final: Message = { role: "user", content: question };
  // Keep explicit decisions first, then recent dialogue, then remaining history.
  const priority = [...candidates.filter(row => rows[row.index].id && pins.includes(rows[row.index].id!)),
    ...candidates.filter(row => row.message.role === "user" && /\b(?:decision|remember|chosen|agreed|prefer)\b/i.test(row.message.content)),
    ...candidates.slice(-20).reverse(), ...candidates];
  const seen = new Set<number>();
  for (const row of priority) {
    if (seen.has(row.index)) continue;
    seen.add(row.index);
    if (bytes([...selected.map(item => item.message), row.message, final]) <= CONVERSATION_CONTEXT_BYTES) selected.push(row);
  }
  if (pins.some(id => !selected.some(row => rows[row.index].id === id)))
    throw new Error("Pinned requests exceed the history budget. Remove a pin or shorten the current question.");
  const messages = [...selected.sort((a, b) => a.index - b.index).map(row => row.message), final];
  return { messages, snapshot: { version: 1, historyRows: rows.length, includedRows: selected.length,
    omittedRows: rows.length - selected.length - (current >= 0 ? 1 : 0), bytes: bytes(messages), budgetBytes: CONVERSATION_CONTEXT_BYTES,
    scopes: [...new Set(selected.flatMap(row => row.scopes))],
    messageIds: selected.flatMap(row => rows[row.index].id ? [rows[row.index].id!] : []),
    pinnedMessageIds: selected.flatMap(row => rows[row.index].id && pins.includes(rows[row.index].id!) ? [rows[row.index].id!] : []),
    includeHistory: options.includeHistory !== false } };
}

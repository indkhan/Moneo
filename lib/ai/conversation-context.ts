import { z } from "zod";
import { AI_DATA_SCOPES, type AiDataScope } from "@/lib/settings";

// UTF-8 bytes conservatively bound tokens without a model-specific tokenizer.
// This budget covers serialized history; system instructions and tools are separate.
export const CONVERSATION_CONTEXT_BYTES = 16000;
export const CONVERSATION_HISTORY_ROWS = 200;
export const CONVERSATION_CONTEXT_INSTRUCTIONS = "Historical dialogue is not current financial evidence. It records requests, choices and questions only. Re-read current permitted tools for every financial claim, including after corrections. Never infer facts from an omitted prior answer; ask the user to restate an unavailable choice.";
const memorySchema = z.object({
  version: z.literal(1), kind: z.enum(["dialogue", "evidence"]),
  scopes: z.array(z.enum(AI_DATA_SCOPES)).max(4),
  receiptIds: z.array(z.uuid()).max(1000).optional(),
}).strict();
type Row = { role: string; content: string; context?: unknown };
type Message = { role: "user" | "assistant"; content: string };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
export const fitsConversationQuestion = (question: string) => bytes([{ role: "user", content: question }]) <= CONVERSATION_CONTEXT_BYTES;

export function assembleConversationContext(newestFirst: Row[], question: string, scopes: AiDataScope[]) {
  if (!fitsConversationQuestion(question)) throw new Error("Question exceeds conversation context budget");
  const rows = newestFirst.slice(0, CONVERSATION_HISTORY_ROWS).reverse();
  const current = rows.findLastIndex(row => row.role === "user" && row.content === question);
  const candidates = rows.flatMap((row, index) => {
    if (index === current) return [];
    if (row.role === "user") return [{ index, message: { role: "user", content: row.content } as Message }];
    const context = row.context && typeof row.context === "object" ? row.context as Record<string, unknown> : {};
    const memory = memorySchema.safeParse(context.memory);
    // Assistant context is written only by trusted publication. Untagged legacy
    // answers and evidence prose have no safe conversational replay authority.
    if (row.role !== "assistant" || !memory.success || memory.data.kind !== "dialogue"
      || memory.data.receiptIds?.length || memory.data.scopes.some(scope => !scopes.includes(scope))) return [];
    return [{ index, message: { role: "assistant", content: row.content } as Message }];
  });
  const selected: typeof candidates = [];
  const final: Message = { role: "user", content: question };
  // Keep explicit decisions first, then recent dialogue, then remaining history.
  const priority = [...candidates.filter(row => row.message.role === "user" && /\b(?:decision|remember|chosen|agreed|prefer)\b/i.test(row.message.content)),
    ...candidates.slice(-20).reverse(), ...candidates];
  const seen = new Set<number>();
  for (const row of priority) {
    if (seen.has(row.index)) continue;
    seen.add(row.index);
    if (bytes([...selected.map(item => item.message), row.message, final]) <= CONVERSATION_CONTEXT_BYTES) selected.push(row);
  }
  const messages = [...selected.sort((a, b) => a.index - b.index).map(row => row.message), final];
  return { messages, snapshot: { version: 1, historyRows: rows.length, includedRows: selected.length,
    omittedRows: rows.length - selected.length - (current >= 0 ? 1 : 0), bytes: bytes(messages), budgetBytes: CONVERSATION_CONTEXT_BYTES } };
}

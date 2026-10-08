import { z } from "zod";
const snapshotSchema = z.object({
  memory: z.object({ version: z.literal(1), scopes: z.array(z.string()).max(4) }),
  assembly: z.object({ historyRows: z.number().int().min(0), includedRows: z.number().int().min(0), omittedRows: z.number().int().min(0) }),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(32000) })).min(1).max(210),
});
export function ChatContextSnapshot({ context }: { context: unknown }) {
  const snapshot = snapshotSchema.safeParse(context);
  if (!snapshot.success) return null;
  const { assembly, memory, messages } = snapshot.data;
  return <details className="mt-3 rounded border border-border p-3 text-xs"><summary className="cursor-pointer">Context used for this answer</summary>
    <p className="mt-2 text-muted-foreground">Saved initial context: {assembly.includedRows} earlier messages included from {assembly.historyRows} considered; {assembly.omittedRows} omitted for access, provenance or budget. Tool evidence is linked in the answer. This describes that turn; financial facts are read again for a new question.</p>
    <p className="mt-2">Evidence access used: {memory.scopes.join(", ") || "no financial data"}.</p>
    <ol className="mt-3 space-y-3">{messages.map((message, index) => <li key={index}><strong>{message.role === "assistant" ? "Permitted earlier dialogue" : "Request or current context"}</strong><p className="mt-1 whitespace-pre-wrap break-words">{message.content}</p></li>)}</ol>
  </details>;
}

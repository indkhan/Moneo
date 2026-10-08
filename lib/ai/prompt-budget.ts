import { asSchema, type ToolSet } from "ai";

// The application prompt (instructions, serialized messages and tool schemas)
// has a byte ceiling independent of billing estimates or provider tokenizers.
export const CHAT_PROMPT_BYTES = 65536;
export async function preparePromptBudget(instructions: unknown, tools: ToolSet) {
  const definitions = await Promise.all(Object.entries(tools).map(async ([name, definition]) => ({
    name, description: definition.description, inputSchema: await asSchema(definition.inputSchema).jsonSchema,
  })));
  const steps = new Map<number, number>();
  return {
    check(messages: unknown[], step: number) {
      const bytes = new TextEncoder().encode(JSON.stringify({ instructions, messages, tools: definitions })).length;
      if (bytes > CHAT_PROMPT_BYTES) throw new Error("Context exceeds the 65536-byte prompt budget. Narrow the question or remove earlier context.");
      steps.set(step, bytes);
    },
    snapshot: () => ({ promptBudgetBytes: CHAT_PROMPT_BYTES, promptSteps: [...steps].map(([step, bytes]) => ({ step, bytes })) }),
  };
}

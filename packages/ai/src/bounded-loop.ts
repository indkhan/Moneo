export async function runBoundedAssistant(
  limits: { maxModelTurns: number; maxToolCalls: number; maxWallTimeMs: number; maxResultBytes: number },
  turn: () => Promise<{ text?: string; toolCalls?: Array<() => Promise<unknown>> }>,
): Promise<{ status: "succeeded" | "limit"; text: string }> {
  const started = Date.now(); let toolCalls = 0; let text = "";
  for (let turnNumber = 0; turnNumber < limits.maxModelTurns; turnNumber++) {
    if (Date.now() - started > limits.maxWallTimeMs) return { status: "limit", text };
    const next = await turn();
    if (next.text !== undefined) { text = next.text; return Buffer.byteLength(text) <= limits.maxResultBytes ? { status: "succeeded", text } : { status: "limit", text: "" }; }
    for (const call of next.toolCalls ?? []) {
      if (toolCalls >= limits.maxToolCalls) return { status: "limit", text };
      await call(); toolCalls++;
    }
  }
  return { status: "limit", text };
}

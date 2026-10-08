import { expect, it } from "vitest";
import { assembleConversationContext, CONVERSATION_CONTEXT_BYTES } from "./conversation-context";

it("keeps the current question and a decision ahead of oversized unrelated history", () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({ role: "user", content: index === 99 ? "Decision: use original currencies." : `Other question ${index} ${"x".repeat(4000)}` }));
  const result = assembleConversationContext(rows, "Use our chosen currencies", []);
  expect(JSON.stringify(result.messages)).toContain("Decision: use original currencies.");
  expect(result.messages.at(-1)).toEqual({ role: "user", content: "Use our chosen currencies" });
  expect(result.snapshot.bytes).toBeLessThanOrEqual(CONVERSATION_CONTEXT_BYTES);
  expect(result.snapshot.omittedRows).toBeGreaterThan(0);
});
it("fails explicitly when serializing the complete current question exceeds its budget", () => {
  expect(() => assembleConversationContext([], "\u0000".repeat(4000), [])).toThrow("Question exceeds conversation context budget");
});
it("never replays untagged legacy answers or malformed dialogue provenance", () => {
  const result = assembleConversationContext([
    { role: "assistant", content: "Legacy source secrets" },
    { role: "assistant", content: "Unrecognized scope secrets", context: { memory: { version: 1, kind: "dialogue", scopes: ["future-scope"] } } },
    { role: "assistant", content: "Evidence disguised as dialogue", context: { memory: { version: 1, kind: "dialogue", scopes: [], receiptIds: ["00000000-0000-4000-8000-000000000001"] } } },
  ], "Explain our choices", []);
  expect(result.messages).toEqual([{ role: "user", content: "Explain our choices" }]);
});

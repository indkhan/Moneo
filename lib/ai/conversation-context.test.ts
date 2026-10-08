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
it("keeps an explicitly pinned request while the user removes automatic history", () => {
  const pinned = "00000000-0000-4000-8000-000000000009";
  const result = assembleConversationContext([
    { id: pinned, role: "user", content: "Compare September with August." },
    { role: "user", content: "Unrelated earlier conversation" },
  ], "Use the pinned comparison", [], { includeHistory: false, pinnedMessageIds: [pinned] });
  expect(result.messages).toEqual([{ role: "user", content: "Compare September with August." }, { role: "user", content: "Use the pinned comparison" }]);
  expect(result.snapshot.messageIds).toEqual([pinned]);
});
it("retains pinned requests outside the automatic two-hundred-message window", () => {
  const pinned = "00000000-0000-4000-8000-000000000009";
  const rows = [...Array.from({ length: 200 }, () => ({ role: "user", content: "Recent unrelated question" })),
    { id: pinned, role: "user", content: "The older chosen comparison." }];
  const result = assembleConversationContext(rows, "Use the pinned comparison", [], { pinnedMessageIds: [pinned] });
  expect(JSON.stringify(result.messages)).toContain("The older chosen comparison.");
});
it("asks users to remove a pin when complete pinned requests cannot fit", () => {
  const rows = Array.from({ length: 8 }, (_, index) => ({ id: String(index), role: "user", content: "x".repeat(4000) }));
  expect(() => assembleConversationContext(rows, "Use our pinned choices", [], { pinnedMessageIds: rows.map(row => row.id) })).toThrow("Pinned requests exceed the history budget");
});
it("does not mistake an identical older pinned question for the current request", () => {
  const result = assembleConversationContext([{ id: "pin", request_id: "old", role: "user", content: "Use original currencies." }],
    "Use original currencies.", [], { currentRequestId: "new", pinnedMessageIds: ["pin"], includeHistory: false });
  expect(result.snapshot.messageIds).toEqual(["pin"]);
});

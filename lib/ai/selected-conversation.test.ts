import { expect, it, vi } from "vitest";
import { SELECTION_IDLE_SECONDS, selectConversation } from "./selected-conversation";

it("remembers the open chat only for an idle window, so a later visit starts a new chat", () => {
  const doc = { cookie: "" };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("location", { protocol: "https:" });
  selectConversation("moneo-conversation-w", "abc", false);
  expect(doc.cookie).toBe(`moneo-conversation-w=abc; Path=/; Max-Age=${SELECTION_IDLE_SECONDS}; SameSite=Lax; Secure`);
  vi.unstubAllGlobals();
});

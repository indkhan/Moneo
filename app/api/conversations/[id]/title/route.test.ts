import { expect, it, vi } from "vitest";
import { POST } from "./route";
import { conversationWords } from "@/lib/ai/chat-title";

vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ supabase: {}, workspace: { id: "w" }, settings: {} }) }));
vi.mock("@/lib/ai/provider", () => ({ modelForSettings: vi.fn() }));
vi.mock("@/lib/ai/chat-title", () => ({ conversationWords: vi.fn(), writeTitle: vi.fn() }));

it("says the chat could not be read when the database fails, not that it has nothing to name", async () => {
  vi.mocked(conversationWords).mockRejectedValue(new Error("database down"));
  const response = await POST(new Request("http://localhost/"), { params: Promise.resolve({ id: crypto.randomUUID() }) });
  expect(response.status).toBe(500);
});

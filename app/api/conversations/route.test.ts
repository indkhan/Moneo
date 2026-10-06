import { beforeEach, expect, it, vi } from "vitest";
import { GET } from "./route";
import { requireWorkspace } from "@/lib/auth";
import { loadConversationHistory } from "@/lib/ai/conversation-history";
vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("@/lib/ai/conversation-history", () => ({ loadConversationHistory: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (key: string) => key === "moneo-conversation-owned" ? { value: "saved" } : undefined }) }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireWorkspace).mockResolvedValue({ workspace: { id: "owned" }, supabase: {} } as never);
  vi.mocked(loadConversationHistory).mockResolvedValue({ selected: null, threads: [], messages: [], messagesCursor: null, threadsCursor: null });
});
it("uses the authenticated workspace's selection after reload and lets explicit New override it", async () => {
  const response = await GET(new Request("http://localhost/api/conversations"));
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(loadConversationHistory).toHaveBeenLastCalledWith({}, "owned", "saved", undefined, undefined);
  await GET(new Request("http://localhost/api/conversations?conversation=new"));
  expect(loadConversationHistory).toHaveBeenLastCalledWith({}, "owned", "new", undefined, undefined);
});
it("exposes safe loader errors and never returns a new conversation instead", async () => {
  vi.mocked(loadConversationHistory).mockRejectedValue(new Error("Could not load messages. Try again."));
  const response = await GET(new Request("http://localhost/api/conversations?conversation=missing"));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ selectionKey: "moneo-conversation-owned", error: "Could not load messages. Try again." });
});
it("requires authentication and never queries history for another workspace", async () => {
  vi.mocked(requireWorkspace).mockRejectedValue(new Error("Unauthorized"));
  expect((await GET(new Request("http://localhost/api/conversations"))).status).toBe(401);
  expect(loadConversationHistory).not.toHaveBeenCalled();
});

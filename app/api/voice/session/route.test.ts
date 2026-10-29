import { beforeEach, expect, it, vi } from "vitest";
import { POST } from "./route";
import { requireWorkspace } from "@/lib/auth";

const { doCreateWebRTCSession } = vi.hoisted(() => ({ doCreateWebRTCSession: vi.fn(async (options: { sdp: string; sessionConfig: { instructions: string; voice: string; providerOptions: { openai: { input: unknown[] } } } }) => { void options; return { sessionId: "session", sdp: "answer" }; }) }));
vi.mock("@ai-sdk/openai", () => ({ openai: { experimental_realtime: () => ({ doCreateWebRTCSession }) } }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));

const conversationId = "00000000-0000-4000-8000-000000000002";
let conversation: unknown, messages: { role: string; content: string }[];
const eqs: unknown[][] = [];
beforeEach(() => {
  vi.clearAllMocks(); eqs.length = 0; process.env.OPENAI_API_KEY = "test";
  conversation = { id: conversationId, deleted_at: null }; messages = [];
  const query = { select: () => query, eq: (...args: unknown[]) => { eqs.push(args); return query; }, order: () => query,
    limit: async (count: number) => ({ data: messages.slice(-count).reverse(), error: null }), maybeSingle: async () => ({ data: conversation, error: null }) };
  vi.mocked(requireWorkspace).mockResolvedValue({ supabase: { from: () => query }, workspace: { id: "workspace" }, settings: {} } as unknown as Awaited<ReturnType<typeof requireWorkspace>>);
});
const request = (body: unknown) => new Request("http://localhost/api/voice/session", { method: "POST", body: JSON.stringify(body) });

it("requires a signed-in workspace", async () => {
  vi.mocked(requireWorkspace).mockRejectedValueOnce(new Error("no"));
  expect((await POST(request({ sdp: "offer", conversationId }))).status).toBe(401);
});
it.each([{}, { sdp: "offer" }, { sdp: "", conversationId }, { sdp: "offer", conversationId: "nope" }, { sdp: "offer", conversationId, extra: 1 }])("rejects invalid bodies %#", async body => {
  expect((await POST(request(body))).status).toBe(400);
  expect(doCreateWebRTCSession).not.toHaveBeenCalled();
});
it("refuses a deleted conversation and only reads this workspace's", async () => {
  conversation = { id: conversationId, deleted_at: "2026-10-01" };
  expect((await POST(request({ sdp: "offer", conversationId }))).status).toBe(404);
  expect(eqs).toContainEqual(["workspace_id", "workspace"]);
  expect(doCreateWebRTCSession).not.toHaveBeenCalled();
});
it("starts a delegating session seeded with the last ten messages, without cards and bounded", async () => {
  messages = Array.from({ length: 14 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `turn ${index}` }));
  messages[13] = { role: "assistant", content: `Done.\n\n\`\`\`moneo-proposal\nabc\n\`\`\`\n${"x".repeat(3000)}` };
  const response = await POST(request({ sdp: "offer", conversationId }));
  expect(await response.json()).toEqual({ sdp: "answer", sessionId: "session" });
  const { sdp, sessionConfig } = doCreateWebRTCSession.mock.calls[0][0];
  expect(sdp).toBe("offer");
  expect(sessionConfig.voice).toBe("marin");
  expect(sessionConfig.instructions).toContain("<|SpawnThinking|>");
  const input = sessionConfig.providerOptions.openai.input as { role: string; content: [{ text: string }] }[];
  expect(input).toHaveLength(10);
  expect(input[0]).toEqual({ type: "message", role: "user", content: [{ type: "input_text", text: "turn 4" }] });
  expect(input[9].content[0].text).not.toContain("moneo-proposal");
  expect(input[9].content[0].text.length).toBeLessThanOrEqual(1000);
  expect(sessionConfig.providerOptions.openai).toMatchObject({ delegation: { type: "client" } });
});
it("starts a new chat's call with no history", async () => {
  conversation = null;
  expect((await POST(request({ sdp: "offer", conversationId }))).status).toBe(200);
  expect(doCreateWebRTCSession.mock.calls[0][0].sessionConfig.providerOptions.openai.input).toEqual([]);
});

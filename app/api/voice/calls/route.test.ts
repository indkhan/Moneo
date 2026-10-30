import { beforeEach, expect, it, vi } from "vitest";
import { POST } from "./route";
import { requireWorkspace } from "@/lib/auth";
import { summarizeCall } from "@/lib/ai/voice-call-record";
import { DEFAULT_SETTINGS } from "@/lib/settings";

const { after } = vi.hoisted(() => ({ after: vi.fn() }));
vi.mock("next/server", async original => ({ ...await original<typeof import("next/server")>(), after }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("@/lib/ai/provider", () => ({ modelForSettings: vi.fn(async () => ({ modelId: "chat" })) }));
vi.mock("@/lib/ai/voice-call-record", async original => ({ ...await original<typeof import("@/lib/ai/voice-call-record")>(), summarizeCall: vi.fn() }));

const conversationId = "00000000-0000-4000-8000-000000000002";
const callId = "00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000003";
const record = { id: callId, conversationId, durationSeconds: 75, transcript: [{ role: "user", text: "How much at Netto?" }, { role: "assistant", text: "42 euros" }], tasks: [{ requestId, text: "How much at Netto?", status: "done" }] };
let conversation: unknown, insertError: { code: string } | null;
const inserts: [string, unknown][] = [];
const eqs: unknown[][] = [];

beforeEach(() => {
  vi.clearAllMocks(); inserts.length = 0; eqs.length = 0; insertError = null;
  conversation = { id: conversationId, deleted_at: null };
  const supabase = { from: (table: string) => {
    const query = { select: () => query, eq: (...args: unknown[]) => { eqs.push(args); return query; }, maybeSingle: async () => ({ data: conversation, error: null }),
      insert: async (row: unknown) => { inserts.push([table, row]); return { error: table === "voice_calls" ? insertError : null }; } };
    return query;
  } };
  vi.mocked(requireWorkspace).mockResolvedValue({ supabase, workspace: { id: "workspace" }, settings: DEFAULT_SETTINGS } as unknown as Awaited<ReturnType<typeof requireWorkspace>>);
});
const request = (body: unknown) => new Request("http://localhost/api/voice/calls", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

it("requires a signed-in workspace", async () => {
  vi.mocked(requireWorkspace).mockRejectedValueOnce(new Error("no"));
  expect((await POST(request(record))).status).toBe(401);
  expect(inserts).toEqual([]);
});
it.each([
  ["not json", "{"], ["empty transcript", { ...record, transcript: [] }], ["bad conversation", { ...record, conversationId: "nope" }],
  ["extra field", { ...record, workspace_id: "other" }], ["bad status", { ...record, tasks: [{ requestId, text: "x", status: "weird" }] }],
])("rejects %s", async (_name, body) => {
  expect((await POST(request(body))).status).toBe(400);
  expect(inserts).toEqual([]);
});
it("rejects a transcript over 40 KB and a body over 64 KB", async () => {
  const big = { role: "assistant", text: "x".repeat(4000) };
  expect((await POST(request({ ...record, transcript: Array(11).fill(big) }))).status).toBe(400);
  expect((await POST(request({ ...record, tasks: [{ requestId, text: "x".repeat(70_000), status: "done" }] }))).status).toBe(413);
  expect(inserts).toEqual([]);
});
it("refuses a deleted conversation and only reads this workspace's", async () => {
  conversation = { id: conversationId, deleted_at: "2026-10-01" };
  expect((await POST(request(record))).status).toBe(404);
  expect(eqs).toContainEqual(["workspace_id", "workspace"]);
  expect(inserts).toEqual([]);
  expect(after).not.toHaveBeenCalled();
});
it("saves the call under the workspace and summarizes it after responding", async () => {
  const response = await POST(request(record));
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ id: callId });
  expect(inserts).toEqual([["voice_calls", { id: callId, workspace_id: "workspace", conversation_id: conversationId, duration_seconds: 75, transcript: record.transcript, tasks: record.tasks, request_ids: [requestId] }]]);
  // Nothing was summarized yet: the work is queued for after the response.
  expect(summarizeCall).not.toHaveBeenCalled();
  expect(after).toHaveBeenCalledTimes(1);
  await after.mock.calls[0][0]();
  expect(summarizeCall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ workspaceId: "workspace", callId, transcript: record.transcript }));
});
it("creates the conversation of a new chat whose call asked nothing", async () => {
  conversation = null;
  expect((await POST(request({ ...record, tasks: [] }))).status).toBe(201);
  expect(inserts[0]).toEqual(["conversations", { id: conversationId, workspace_id: "workspace", title: "How much at Netto?" }]);
  expect(inserts[1][0]).toBe("voice_calls");
});
it("treats a repeated save of the same call as done, without a second summary", async () => {
  insertError = { code: "23505" };
  const response = await POST(request(record));
  expect(response.status).toBe(200);
  expect(after).not.toHaveBeenCalled();
});

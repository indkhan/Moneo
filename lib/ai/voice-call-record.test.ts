import { beforeEach, expect, it, vi } from "vitest";
import { generateText } from "ai";
import { MAX_TRANSCRIPT_BYTES, SUMMARY_INPUT_CHARS, boundTranscript, callRecordSchema, parseSummary, summarizeCall, summaryInput } from "./voice-call-record";

vi.mock("ai", async importOriginal => ({ ...await importOriginal<typeof import("ai")>(), generateText: vi.fn() }));

const id = "00000000-0000-4000-8000-000000000001";
const valid = { id, conversationId: "00000000-0000-4000-8000-000000000002", durationSeconds: 90, transcript: [{ role: "user", text: "hi" }], tasks: [] };

it("accepts a call record and rejects bad ones", () => {
  expect(callRecordSchema.safeParse(valid).success).toBe(true);
  for (const bad of [{ ...valid, id: "x" }, { ...valid, durationSeconds: -1 }, { ...valid, durationSeconds: 1.5 }, { ...valid, transcript: [] },
    { ...valid, transcript: [{ role: "system", text: "hi" }] }, { ...valid, transcript: [{ role: "user", text: " " }] }, { ...valid, extra: 1 },
    { ...valid, tasks: [{ requestId: id, text: "x", status: "weird" }] }, { ...valid, tasks: Array(31).fill({ requestId: id, text: "x", status: "done" }) }])
    expect(callRecordSchema.safeParse(bad).success).toBe(false);
});
it("limits the transcript to 40 KB", () => {
  const turn = { role: "assistant" as const, text: "x".repeat(4000) };
  expect(callRecordSchema.safeParse({ ...valid, transcript: Array(9).fill(turn) }).success).toBe(true);
  expect(callRecordSchema.safeParse({ ...valid, transcript: Array(11).fill(turn) }).success).toBe(false);
});
it("keeps the newest turns that fit", () => {
  const turns = Array.from({ length: 60 }, (_, index) => ({ role: "user" as const, text: `${index} ${"y".repeat(3000)}` }));
  const kept = boundTranscript(turns);
  expect(new TextEncoder().encode(JSON.stringify(kept)).length).toBeLessThanOrEqual(MAX_TRANSCRIPT_BYTES);
  expect(kept.at(-1)?.text.startsWith("59 ")).toBe(true);
  expect(callRecordSchema.safeParse({ ...valid, transcript: kept }).success).toBe(true);
  expect(boundTranscript([{ role: "user", text: "  " }, { role: "assistant", text: " ok " }])).toEqual([{ role: "assistant", text: "ok" }]);
});
it("bounds what the summary model reads, keeping the start and end of a long call", () => {
  const transcript = Array.from({ length: 200 }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const, text: `turn ${index} ${"z".repeat(200)}` }));
  const input = summaryInput(transcript);
  expect(input.length).toBeLessThanOrEqual(SUMMARY_INPUT_CHARS + 10);
  expect(input.startsWith("User: turn 0")).toBe(true);
  expect(input).toContain("turn 199");
  expect(summaryInput([{ role: "user", text: "short" }, { role: "assistant", text: "yes" }])).toBe("User: short\nMoneo: yes");
});
it("keeps up to four bullets", () => {
  expect(parseSummary("Here you go:\n- one\n* two\n• three\n- four\n- five")).toBe("- one\n- two\n- three\n- four");
  expect(parseSummary("no bullets")).toBeNull();
});

const update = vi.fn();
function client() {
  const query = { eq: vi.fn(() => query), then: (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve) };
  update.mockReturnValue(query);
  return { supabase: { from: vi.fn(() => ({ update })) } as never, query };
}
beforeEach(() => { vi.clearAllMocks(); vi.spyOn(console, "error").mockImplementation(() => {}); });

it("writes the generated summary onto this workspace's call", async () => {
  vi.mocked(generateText).mockResolvedValue({ text: "- Asked about Netto\n- Added lunch" } as never);
  const { supabase, query } = client();
  await summarizeCall(supabase, { workspaceId: "w", callId: id, transcript: valid.transcript as never, model: async () => ({ modelId: "m" }) as never });
  expect(vi.mocked(generateText).mock.calls[0][0]).toMatchObject({ prompt: "User: hi", maxOutputTokens: 400 });
  expect(update).toHaveBeenCalledWith({ summary: "- Asked about Netto\n- Added lunch", summary_status: "done" });
  expect(query.eq.mock.calls).toEqual([["workspace_id", "w"], ["id", id]]);
});
it("marks the call failed when the model errors", async () => {
  vi.mocked(generateText).mockRejectedValue(new Error("down"));
  const { supabase } = client();
  await summarizeCall(supabase, { workspaceId: "w", callId: id, transcript: valid.transcript as never, model: async () => ({}) as never });
  expect(update).toHaveBeenCalledWith({ summary: null, summary_status: "failed" });
});
it("marks the call failed when the model says nothing useful", async () => {
  vi.mocked(generateText).mockResolvedValue({ text: "I cannot." } as never);
  const { supabase } = client();
  await summarizeCall(supabase, { workspaceId: "w", callId: id, transcript: valid.transcript as never, model: async () => ({}) as never });
  expect(update).toHaveBeenCalledWith({ summary: null, summary_status: "failed" });
});

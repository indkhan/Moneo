import { beforeEach, expect, test, vi } from "vitest";
import { CALL_LOG_HEADER } from "@/lib/ai/voice-call-audio";
import { requireWorkspace } from "@/lib/auth";
import { logInfo } from "@/lib/log";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("@/lib/log", () => ({ logInfo: vi.fn() }));

const workspaceId = "00000000-0000-4000-8000-000000000001";
const otherWorkspace = "00000000-0000-4000-8000-000000000002";
const id = "00000000-0000-4000-8000-000000000003";
const conversationId = "00000000-0000-4000-8000-000000000004";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireWorkspace).mockResolvedValue({ workspace: { id: workspaceId } } as Awaited<ReturnType<typeof requireWorkspace>>);
});

function request(owner: string, audio?: Blob, header = true) {
  const body = new FormData();
  body.set("record", JSON.stringify({ id, workspaceId: owner, conversationId, durationSeconds: 12, transcript: [] }));
  if (audio) body.set("audio", audio);
  return new Request("http://localhost/api/logs/voice-call", { method: "POST", headers: header ? { [CALL_LOG_HEADER]: "1" } : {}, body });
}

test("keeps audio from a call that ended before a transcript was available", async () => {
  const bytes = Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3);
  expect((await POST(request(workspaceId, new Blob([bytes], { type: "audio/webm" })))).status).toBe(204);
  expect(logInfo).toHaveBeenCalledExactlyOnceWith("voice", "voice.call_end", expect.any(String), {
    callId: id, durationSeconds: 12, transcript: [],
  }, { workspaceId, conversationId, audio: { bytes: bytes.buffer, contentType: "audio/webm" } });
});

test("does not accept a recording from a previous workspace", async () => {
  expect((await POST(request(otherWorkspace))).status).toBe(409);
  expect(logInfo).not.toHaveBeenCalled();
});

test("does not log a cross-site form post", async () => {
  expect((await POST(request(workspaceId, undefined, false))).status).toBe(403);
  expect(logInfo).not.toHaveBeenCalled();
});

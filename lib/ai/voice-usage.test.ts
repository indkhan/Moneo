import { afterEach, expect, it, vi } from "vitest";
import { voiceUsageReporter } from "./voice-usage";

const id = "00000000-0000-4000-8000-000000000001";

afterEach(() => vi.unstubAllGlobals());

it("reports cumulative token counts once per provider response or completed transcription", () => {
  const send = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", send);
  const report = voiceUsageReporter(id);
  const first = { type: "response.done", response: { id: "response-1", usage: { input_tokens: 27, output_tokens: 9, input_token_details: { cached_tokens: 6 } } } };
  report(first);
  report(first);
  report({ type: "conversation.item.input_audio_transcription.completed", item_id: "audio-1", usage: { type: "tokens", input_tokens: 13, output_tokens: 4 } });
  report({ type: "response.done", response: { id: "response-2" } });
  expect(send.mock.calls).toHaveLength(2);
  expect(send).toHaveBeenLastCalledWith("/api/voice/usage", expect.objectContaining({
    body: JSON.stringify({ kind: "tokens", id, input: 40, output: 13, cached: 6 }),
  }));
});

it("keeps the newest cumulative GPT-Live audio duration instead of adding snapshots", () => {
  const send = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", send);
  const report = voiceUsageReporter(id);
  report({ type: "session.usage.updated", usage: { seconds: 3 } });
  report({ type: "session.usage.updated", usage: { seconds: 8 } });
  report({ type: "session.closed", usage: { seconds: 12 } });
  expect(send).toHaveBeenLastCalledWith("/api/voice/usage", expect.objectContaining({
    body: JSON.stringify({ kind: "audio", id, seconds: 12 }),
  }));
});

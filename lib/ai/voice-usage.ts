type VoiceUsage = { kind: "tokens"; id: string; input: number; output: number; cached: number }
  | { kind: "audio"; id: string; seconds: number };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function count(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function reportUsageFailure(error: unknown) {
  console.warn("Voice usage could not be saved", error);
}

export function voiceUsageReporter(id: unknown) {
  const seen = new Set<string>();
  let input = 0, output = 0, cached = 0, audioSeconds = 0;
  const send = (body: VoiceUsage) => {
    void fetch("/api/voice/usage", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive: true,
    }).then(response => {
      if (!response.ok) reportUsageFailure(response.status);
    }, reportUsageFailure);
  };
  return (value: unknown) => {
    if (typeof id !== "string") return;
    const event = record(value);
    const response = event?.type === "response.done" ? record(event.response) : undefined;
    const usage = record(response?.usage ?? event?.usage);
    if (!usage) return;
    const seconds = usage.seconds;
    const validSeconds = typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0;
    if (event?.type === "session.usage.updated" || event?.type === "session.closed") {
      if (validSeconds && seconds >= audioSeconds) {
        audioSeconds = seconds;
        send({ kind: "audio", id, seconds: audioSeconds });
      }
      return;
    }
    const key = event?.type === "conversation.item.input_audio_transcription.completed" ? event.item_id : response?.id;
    if (typeof key !== "string" || !key || seen.has(key)) return;
    if (usage.type === "duration" && validSeconds) {
      seen.add(key);
      audioSeconds += seconds;
      send({ kind: "audio", id, seconds: audioSeconds });
      return;
    }
    const nextInput = count(usage.input_tokens), nextOutput = count(usage.output_tokens);
    if (nextInput === null || nextOutput === null) return;
    seen.add(key);
    input += nextInput;
    output += nextOutput;
    cached += count(record(usage.input_token_details)?.cached_tokens) ?? 0;
    send({ kind: "tokens", id, input, output, cached });
  };
}

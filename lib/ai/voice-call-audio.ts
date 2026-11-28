import type { CallRecordInput } from "./voice-call-record";

export const MAX_CALL_AUDIO_BYTES = 24 * 1024 * 1024;
export const CALL_AUDIO_TYPES = ["audio/webm", "audio/ogg", "audio/mp4"] as const;
export const CALL_LOG_HEADER = "x-moneo-call-log";

export class VoiceCallAudio {
  private readonly mix: MediaStreamAudioDestinationNode;
  private recorder: MediaRecorder | undefined;
  private readonly chunks: Blob[] = [];
  private size = 0;
  private finished: Promise<Blob | undefined> | undefined;

  constructor(private readonly context: AudioContext) {
    this.mix = context.createMediaStreamDestination();
  }

  add(stream: MediaStream) {
    this.context.createMediaStreamSource(stream).connect(this.mix);
  }

  start() {
    if (this.recorder || typeof MediaRecorder === "undefined") return;
    const mimeType = CALL_AUDIO_TYPES.find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) return;
    const recorder = new MediaRecorder(this.mix.stream, { mimeType, audioBitsPerSecond: 48_000 });
    this.recorder = recorder;
    this.finished = new Promise(resolve => {
      recorder.addEventListener("dataavailable", ({ data }) => {
        if (!data.size) return;
        if (this.size + data.size > MAX_CALL_AUDIO_BYTES) {
          if (recorder.state !== "inactive") recorder.stop();
          return;
        }
        this.chunks.push(data);
        this.size += data.size;
      });
      recorder.addEventListener("stop", () => resolve(this.size ? new Blob(this.chunks, { type: recorder.mimeType }) : undefined), { once: true });
      recorder.addEventListener("error", () => resolve(undefined), { once: true });
    });
    recorder.start(1000);
  }

  stop() {
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    return this.finished;
  }
}

export async function postCallLog(record: Omit<CallRecordInput, "tasks">, audio?: Blob) {
  const body = new FormData();
  body.set("record", JSON.stringify(record));
  if (audio) body.set("audio", audio);
  const response = await fetch("/api/logs/voice-call", { method: "POST", headers: { [CALL_LOG_HEADER]: "1" }, body });
  if (!response.ok) throw new Error(`Voice call log could not be saved (${response.status})`);
}

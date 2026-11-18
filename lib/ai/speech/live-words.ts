export const LIVE_WORDS_EVERY_MS = 1000;
export const LIVE_WORDS_WINDOW_SECONDS = 30;

export type InterimTranscriber = (samples: Int16Array<ArrayBuffer>, signal: AbortSignal) => Promise<string | null>;
export type LiveWords = { push: (chunk: Int16Array) => void; recording: () => Int16Array<ArrayBuffer>; stop: () => void };

export function createLiveWords({ sampleRate, transcribe, onText, everyMs = LIVE_WORDS_EVERY_MS }: {
  sampleRate: number; transcribe: InterimTranscriber; onText: (text: string) => void; everyMs?: number;
}): LiveWords {
  const windowSamples = sampleRate * LIVE_WORDS_WINDOW_SECONDS;
  const chunks: Int16Array[] = [];
  const settled: string[] = [];
  let length = 0, windowStart = 0, heardUpTo = 0, current = "", inFlight: AbortController | null = null, missedTick = false;
  const timer = setInterval(tick, everyMs);

  function slice(from: number, to: number) {
    const output = new Int16Array(to - from);
    let offset = 0;
    for (const chunk of chunks) {
      const start = Math.max(from - offset, 0), end = Math.min(to - offset, chunk.length);
      if (start < end) output.set(chunk.subarray(start, end), offset + start - from);
      offset += chunk.length;
      if (offset >= to) break;
    }
    return output;
  }

  function tick() {
    if (inFlight) { missedTick = true; return; }
    missedTick = false;
    if (length <= heardUpTo) return;
    const controller = inFlight = new AbortController();
    const from = windowStart, to = Math.min(length, from + windowSamples);
    heardUpTo = to;
    transcribe(slice(from, to), controller.signal).then(text => {
      inFlight = null;
      if (controller.signal.aborted) return;
      if (text === null) heardUpTo = from;
      else if (to - from < windowSamples) current = text.trim();
      else { settled.push(text.trim()); windowStart = to; current = ""; }
      if (text !== null) onText([...settled, current].filter(Boolean).join(" "));
      if (missedTick) tick();
    }, () => { inFlight = null; clearInterval(timer); });
  }

  return {
    push(chunk) { chunks.push(chunk); length += chunk.length; },
    recording: () => slice(0, length),
    stop() { clearInterval(timer); inFlight?.abort(); },
  };
}

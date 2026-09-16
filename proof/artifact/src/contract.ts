export const LIMITS = {
  sourceBytes: 2 * 1024 * 1024,
  heapBytes: 16 * 1024 * 1024,
  messageBytes: 1024 * 1024,
  messagesPerSecond: 100,
  executionMs: 5_000,
} as const;

export const RENDERER_ORIGIN = "http://127.0.0.1:4174";
export const PROTOCOL = 1;

export type StartMessage = {
  type: "start";
  protocol: 1;
  nonce: string;
  source: { html: string; css: string; js: string };
  state: { version: number; slider: number };
  finance: { categories: { label: string; amount: string }[] };
};

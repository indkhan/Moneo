export const VOICE_CONTEXT = { input: "voice" } as const;
export const isSpoken = (context: unknown) => (context as { input?: unknown } | null)?.input === "voice";

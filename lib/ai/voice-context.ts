/** Saved as the message `context` so a spoken message shows a mic badge and the model knows it was dictated. */
export const VOICE_CONTEXT = { input: "voice" } as const;
export const isSpoken = (context: unknown) => (context as { input?: unknown } | null)?.input === "voice";

import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { VOICES } from "@/lib/settings";

const querySchema = z.object({ voice: z.enum(VOICES) }).strict();
const SAMPLE_LINE = "Hey, it's Moneo. Want me to check your spending?";
// One short clip per voice is the same for everyone, so it is made once per server instance.
const clips = new Map<string, Promise<ArrayBuffer>>();

function makeClip(voice: string, apiKey: string) {
  return fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice, input: SAMPLE_LINE, response_format: "mp3" }),
  }).then(response => { if (!response.ok) throw new Error(`speech ${response.status}`); return response.arrayBuffer(); });
}

/** A short text-to-speech clip of one GPT-Live voice, for the Settings voice picker. */
export async function GET(request: Request) {
  try { await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ error: "Unknown voice" }, { status: 400 });
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return Response.json({ error: "Voice isn't set up on this server: OPENAI_API_KEY is missing" }, { status: 503 });
  const { voice } = parsed.data;
  if (!clips.has(voice)) clips.set(voice, makeClip(voice, apiKey));
  try {
    return new Response(await clips.get(voice)!, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=86400" } });
  } catch (error) {
    clips.delete(voice);
    console.error("voice sample failed", error);
    return Response.json({ error: "Could not play the sample" }, { status: 502 });
  }
}

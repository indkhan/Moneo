// Real end-to-end check of the chat voice call: speaks test sentences (OpenAI TTS) into a fake mic,
// starts a call in /ai as the QA user and checks that delegations ran /api/chat, a card reached the tray
// and Moneo's spoken answers show in the captions. Costs real GPT-Live, TTS and chat-model usage.
// Run with the app on http://localhost:3000 and e2e/.auth.json present (see scripts/e2e-auth.mjs):
//   node --env-file=.env scripts/voice-call-check.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import postgres from "postgres";

const base = process.env.APP_URL ?? "http://localhost:3000";
const sentences = [
  "How much did I spend at Netto this month?",
  "And when is my rent due?",
  "Oh, by the way, I spent twelve euros forty in cash at Netto on chips and eggs.",
];
const pauses = [4, 2];
const RATE = 24000;

// The QA user's chat model may be an OpenRouter id without credits; the check needs a working OpenAI model.
if (process.env.SUPABASE_DB_URL && process.env.E2E_USER_EMAIL) {
  const db = postgres(process.env.SUPABASE_DB_URL, { max: 1, onnotice: () => {} });
  const [row] = await db`select s.workspace_id, s.ai_models->>'chat' as chat from public.workspace_settings s join public.workspaces w on w.id=s.workspace_id
    join auth.users u on u.id=w.owner_id where u.email=${process.env.E2E_USER_EMAIL}`;
  if (row?.chat?.includes("/")) {
    await db`update public.workspace_settings set ai_models = ai_models - 'chat' where workspace_id=${row.workspace_id}`;
    console.log(`chat model was ${row.chat}; reset to the default OpenAI model`);
  }
  await db.end();
}

async function speech(text) {
  const response = await fetch("https://api.openai.com/v1/audio/speech", { method: "POST", headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "alloy", input: text, response_format: "pcm" }) });
  if (!response.ok) throw new Error(`TTS failed: ${response.status} ${await response.text()}`);
  return Buffer.from(await response.arrayBuffer());
}
const silence = seconds => Buffer.alloc(RATE * 2 * seconds);
const clips = await Promise.all(sentences.map(speech));
// Chrome loops the fake mic file, so a long silent tail keeps the questions from repeating during the check.
const pcm = Buffer.concat([silence(3), ...clips.flatMap((clip, index) => [clip, silence(pauses[index] ?? 150)])]);
const header = Buffer.alloc(44);
header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8); header.write("fmt ", 12);
header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
mkdirSync(".qa", { recursive: true });
const wav = resolve(".qa/voice-call-check.wav");
writeFileSync(wav, Buffer.concat([header, pcm]));

const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`, "--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ storageState: "e2e/.auth.json", permissions: ["microphone"] });
const page = await context.newPage();
const chats = [];
page.on("response", async response => {
  if (!response.url().endsWith("/api/chat") || response.request().method() !== "POST") return;
  const request = JSON.parse(response.request().postData() ?? "{}");
  const text = await response.text().catch(() => "");
  const result = text.trim().split("\n").map(line => { try { return JSON.parse(line); } catch { return null; } }).find(event => event?.type === "result");
  chats.push({ message: request.message, via: request.context?.via, status: result?.status ?? response.status(), error: result?.body?.error });
  console.log("chat", chats.at(-1));
});
page.on("console", message => { if (message.type() === "error" || message.text().startsWith("[call]")) console.log(message.text()); });
// Logs GPT-Live's call events (not transcripts or audio) to see each delegation.
await page.addInitScript(() => {
  const create = RTCPeerConnection.prototype.createDataChannel;
  RTCPeerConnection.prototype.createDataChannel = function (...args) {
    const channel = create.apply(this, args);
    channel.addEventListener("message", message => { const event = JSON.parse(message.data); if (!/delta|usage/.test(event.type)) console.log("[call]", event.type, JSON.stringify(event).slice(0, 200)); });
    const send = channel.send.bind(channel);
    channel.send = data => { console.log("[call] sent", String(data).slice(0, 200)); send(data); };
    return channel;
  };
});

await page.goto(`${base}/ai?conversation=new`);
await page.getByRole("button", { name: "Call" }).click();
const call = page.getByRole("dialog", { name: "Voice call with Moneo" });
await call.getByRole("status").filter({ hasText: /Listening|Working|talking/ }).waitFor({ timeout: 30_000 });
console.log("call is live");

const deadline = Date.now() + 150_000;
let cards = 0;
while (Date.now() < deadline) {
  await page.waitForTimeout(3000);
  cards = await call.getByRole("region", { name: "Cards to review" }).getByRole("button").count();
  if (chats.length >= 3 && cards > 0 && !(await call.getByRole("list", { name: "Tasks" }).locator("svg.lucide-loader-circle, svg.lucide-loader2").count())) { await page.waitForTimeout(12_000); break; }
}
const captions = await call.getByLabel("Live captions").innerText();
const tasks = await call.getByRole("list", { name: "Tasks" }).innerText().catch(() => "");
await page.screenshot({ path: ".qa/voice-call-check.png", fullPage: true });
await call.getByRole("button", { name: /End call|Close/ }).click();
await browser.close();

console.log("\n--- captions ---\n" + captions + "\n--- tasks ---\n" + tasks);
const checks = {
  "delegations ran /api/chat in call mode": chats.length >= 2 && chats.every(chat => chat.via === "call"),
  "chat requests completed": chats.filter(chat => chat.status === 200).length >= 2,
  "a card is in the tray": cards > 0,
  "Moneo spoke answers": /Moneo: /.test(captions) || captions.split("\n").length > 3,
};
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);

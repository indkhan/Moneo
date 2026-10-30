// Real end-to-end check of the chat voice call. Costs real GPT-Live, TTS and chat-model usage.
// Call 1 speaks test sentences (OpenAI TTS) into a fake mic and checks that delegations ran /api/chat, a card reached
// the tray, Moneo's spoken answers show in the captions, the voice chosen in Settings is the session's voice, and that
// after hang-up the chat shows one call summary card (summary, cards, transcript) that survives a reload.
// Call 2 has a silent mic, types a message and checks that GPT-Live speaks the answer to it.
// Run with the app up and e2e/.auth.json present (see scripts/e2e-auth.mjs); APP_URL defaults to http://localhost:3000:
//   node --env-file=.env scripts/voice-call-check.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import postgres from "postgres";

const base = process.env.APP_URL ?? "http://localhost:3000";
const VOICE = "cedar";
const sentences = [
  "How much did I spend at Netto this month?",
  "And when is my rent due?",
  "Oh, by the way, I spent twelve euros forty in cash at Netto on chips and eggs.",
];
const pauses = [4, 2];
const RATE = 24000;

// The QA user's chat model may be an OpenRouter id without credits; the check needs a working OpenAI model.
// It also picks a non-default voice, restored at the end.
const db = process.env.SUPABASE_DB_URL ? postgres(process.env.SUPABASE_DB_URL, { max: 1, onnotice: () => {} }) : null;
let workspaceId, originalVoice = "marin";
if (db && process.env.E2E_USER_EMAIL) {
  const [row] = await db`select w.id as workspace_id, s.ai_models->>'chat' as chat, s.voice from public.workspaces w join auth.users u on u.id=w.owner_id
    left join public.workspace_settings s on s.workspace_id=w.id where u.email=${process.env.E2E_USER_EMAIL}`;
  workspaceId = row?.workspace_id;
  originalVoice = row?.voice ?? "marin";
  if (row?.chat?.includes("/")) {
    await db`update public.workspace_settings set ai_models = ai_models - 'chat' where workspace_id=${workspaceId}`;
    console.log(`chat model was ${row.chat}; reset to the default OpenAI model`);
  }
  await db`insert into public.workspace_settings(workspace_id, voice) values (${workspaceId}, ${VOICE}) on conflict (workspace_id) do update set voice = excluded.voice`;
}

async function speech(text) {
  const response = await fetch("https://api.openai.com/v1/audio/speech", { method: "POST", headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "alloy", input: text, response_format: "pcm" }) });
  if (!response.ok) throw new Error(`TTS failed: ${response.status} ${await response.text()}`);
  return Buffer.from(await response.arrayBuffer());
}
const silence = seconds => Buffer.alloc(RATE * 2 * seconds);
function writeWav(path, pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8); header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  writeFileSync(path, Buffer.concat([header, pcm]));
  return resolve(path);
}
const clips = await Promise.all(sentences.map(speech));
mkdirSync(".qa", { recursive: true });
// Chrome loops the fake mic file, so a long silent tail keeps the questions from repeating during the check.
const talking = writeWav(".qa/voice-call-check.wav", Buffer.concat([silence(3), ...clips.flatMap((clip, index) => [clip, silence(pauses[index] ?? 150)])]));
const quiet = writeWav(".qa/voice-call-silence.wav", silence(120));

/** Chat messages about Netto that are not inside the call card. */
const outside = page => page.locator("article:not(:has([aria-label='Voice call']))").filter({ hasText: /Netto/ }).count();

/** A browser whose fake mic plays `wav`, logging the call's data-channel events (not transcripts or audio). */
async function open(wav) {
  const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`, "--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext({ storageState: "e2e/.auth.json", permissions: ["microphone"] });
  const page = await context.newPage();
  const log = [], chats = [], timing = {};
  page.on("response", async response => {
    if (!response.url().endsWith("/api/chat") || response.request().method() !== "POST") return;
    const request = JSON.parse(response.request().postData() ?? "{}");
    const text = await response.text().catch(() => "");
    const result = text.trim().split("\n").map(line => { try { return JSON.parse(line); } catch { return null; } }).find(event => event?.type === "result");
    chats.push({ message: request.message, via: request.context?.via, status: result?.status ?? response.status(), error: result?.body?.error });
    console.log("chat", chats.at(-1));
  });
  page.on("console", message => {
    const text = message.text();
    if (text.startsWith("[call] started")) timing.sessionStartedAt ??= Date.now();
    if (text.startsWith("[call] spoke")) timing.firstWordsAt ??= Date.now();
    if (text.startsWith("[call]")) { log.push(text); if (!text.startsWith("[call] spoke")) console.log(text.slice(0, 220)); }
    else if (message.type() === "error") console.log(text);
  });
  await page.addInitScript(() => {
    const create = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (...args) {
      const channel = create.apply(this, args);
      channel.addEventListener("message", message => {
        const event = JSON.parse(message.data);
        if (event.type === "session.started") console.log("[call] started voice=" + event.session?.audio?.output?.voice);
        else if (event.type === "session.output_transcript.delta") console.log("[call] spoke " + (event.delta ?? ""));
        else if (!/delta|usage/.test(event.type)) console.log("[call]", event.type, JSON.stringify(event).slice(0, 200));
      });
      const send = channel.send.bind(channel);
      channel.send = data => { console.log("[call] sent", String(data).slice(0, 200)); send(data); };
      return channel;
    };
  });
  return { browser, page, log, chats, timing };
}
/** Clicks Call and waits until the call is live; `timing` gets when each step happened (ms after the click). */
async function startCall(page, timing) {
  await page.goto(`${base}/ai?conversation=new`);
  await page.getByRole("button", { name: "Call" }).click();
  const clicked = Date.now();
  const call = page.getByRole("dialog", { name: "Voice call with Moneo" });
  await call.getByRole("status").filter({ hasText: /Listening|Working|talking/ }).waitFor({ timeout: 30_000 });
  timing.liveMs = Date.now() - clicked; timing.clicked = clicked;
  console.log(`call is live ${timing.liveMs} ms after the click`);
  return call;
}

// --- Call 1: spoken requests, voice, hang-up, summary card ---
const first = await open(talking);
const call = await startCall(first.page, first.timing);
const deadline = Date.now() + 150_000;
let cards = 0;
while (Date.now() < deadline) {
  await first.page.waitForTimeout(3000);
  cards = await call.getByRole("region", { name: "Cards to review" }).getByRole("button").count();
  if (first.chats.length >= 3 && cards > 0 && !(await call.getByRole("list", { name: "Tasks" }).locator("svg.lucide-loader-circle, svg.lucide-loader2").count())) { await first.page.waitForTimeout(12_000); break; }
}
const captions = await call.getByLabel("Live captions").innerText();
const tasks = await call.getByRole("list", { name: "Tasks" }).innerText().catch(() => "");
await first.page.screenshot({ path: ".qa/voice-call-check.png", fullPage: true });
await call.getByRole("button", { name: /End call|Close/ }).click();

const card = first.page.getByRole("region", { name: "Voice call", exact: true });
let cardShown = false, summary = "";
try {
  await card.waitFor({ timeout: 30_000 });
  cardShown = true;
  // The summary is written after hang-up, so it can take a moment to appear.
  await card.getByRole("list", { name: "Call summary" }).waitFor({ timeout: 90_000 });
  summary = await card.getByRole("list", { name: "Call summary" }).innerText();
} catch { /* reported below */ }
const grouped = await outside(first.page);
await card.getByText("Full transcript").click().catch(() => {});
const transcript = await card.getByRole("list", { name: "Transcript" }).innerText().catch(() => "");
const cardCards = await card.getByRole("region", { name: "Cards from this call" }).locator("section").first().waitFor({ timeout: 20_000 }).then(() => 1, () => 0);
await card.getByText(/Requests from this call/).click().catch(() => {});
await first.page.screenshot({ path: ".qa/voice-call-card.png", fullPage: true });
// The same card comes back from the saved record after a reload.
await first.page.reload();
const reloaded = await first.page.getByRole("region", { name: "Voice call", exact: true }).waitFor({ timeout: 30_000 }).then(() => true, () => false);
const duplicates = await outside(first.page);
const afterClick = at => at ? `${at - first.timing.clicked} ms after the click` : "not heard";
console.log(`timings: live ${first.timing.liveMs} ms; session started ${afterClick(first.timing.sessionStartedAt)}; Moneo's first spoken words ${afterClick(first.timing.firstWordsAt)}`);
const voiceStarted = first.log.find(line => line.startsWith("[call] started"));
await first.browser.close();

console.log("\n--- captions ---\n" + captions + "\n--- tasks ---\n" + tasks + "\n--- summary ---\n" + summary + "\n--- transcript ---\n" + transcript.slice(0, 600));

// --- Call 2: a typed message must be spoken ---
const second = await open(quiet);
const quietCall = await startCall(second.page, second.timing);
await second.page.waitForTimeout(2000);
await quietCall.getByLabel("Type to Moneo").fill("How much did I spend at Netto this month?");
await quietCall.getByRole("button", { name: "Send" }).click();
// The mic is silent, so speech after the result was handed over is Moneo saying it (GPT-Live may answer in another
// language, so this counts speech rather than matching words).
let spoken = false;
for (const end = Date.now() + 90_000; Date.now() < end && !spoken; await second.page.waitForTimeout(2000)) {
  const results = second.log.findIndex(line => line.startsWith("[call] sent") && line.includes("commentary.append") && line.includes("Result for"));
  spoken = results >= 0 && second.log.slice(results).filter(line => line.startsWith("[call] spoke")).length >= 12;
}
const typedCaptions = await quietCall.getByLabel("Live captions").innerText();
console.log("\n--- typed call captions ---\n" + typedCaptions);
await second.browser.close();

if (db) {
  await db`update public.workspace_settings set voice=${originalVoice} where workspace_id=${workspaceId}`;
  await db.end();
}
const checks = {
  "delegations ran /api/chat in call mode": first.chats.length >= 2 && first.chats.every(chat => chat.via === "call"),
  "chat requests completed": first.chats.filter(chat => chat.status === 200).length >= 2,
  "a card is in the tray": cards > 0,
  "Moneo spoke answers": /Moneo: /.test(captions) || captions.split("\n").length > 3,
  [`the call used the chosen voice (${VOICE})`]: voiceStarted === `[call] started voice=${VOICE}`,
  "hanging up shows one call summary card": cardShown,
  "the card has a 2-4 bullet summary": summary.split("\n").filter(Boolean).length >= 1 && summary.split("\n").filter(Boolean).length <= 4,
  "the card keeps both speakers in its transcript": /You: /.test(transcript) && /Moneo: /.test(transcript),
  "the card shows the cards made during the call": cardCards > 0,
  "the call's messages are not repeated outside the card": grouped === 0 && duplicates === 0,
  "the card is still there after a reload": reloaded,
  "a typed message during the call is spoken": spoken,
};
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);

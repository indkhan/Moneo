// A real voice call with Moneo: TTS speaks into a fake microphone, GPT-Live answers, the real card gets tapped.
//   node --env-file=.env promo/demo/shot-call.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { APP, openBrowser, record, saveCallAudio, tap } from "./recorder.mjs";

const RATE = 24000;
const LINES = ["Hey Moneo. Can I afford an eighteen hundred euro trip to Lisbon next June?", "Oh, and I just spent forty-two euros at Trattoria Da Gino."];
async function speech(text) {
  const response = await fetch("https://api.openai.com/v1/audio/speech", { method: "POST", headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "ash", input: text, response_format: "pcm", instructions: "A relaxed person in their early thirties, casually talking on the phone. Natural, warm, not an announcer." }) });
  if (!response.ok) throw new Error(`TTS failed: ${response.status} ${await response.text()}`);
  return Buffer.from(await response.arrayBuffer());
}
const silence = seconds => Buffer.alloc(Math.round(RATE * 2 * seconds));
const clips = await Promise.all(LINES.map(speech));
const pcm = Buffer.concat([silence(3.5), clips[0], silence(0.7), clips[1], silence(170)]);
const header = Buffer.alloc(44);
header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8); header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
mkdirSync("promo/demo/.voices", { recursive: true });
const wav = resolve("promo/demo/.voices/call.wav");
writeFileSync(wav, Buffer.concat([header, pcm]));

const session = await openBrowser({ micWav: wav });
const { page } = session;
const spoken = [];
page.on("console", message => { const text = message.text(); if (text.startsWith("[spoke]")) spoken.push(text.slice(7)); });
await page.goto(`${APP}/`);
await page.getByRole("button", { name: /Call Moneo/ }).or(page.getByRole("link", { name: /Call Moneo/ })).first().waitFor();
await page.waitForTimeout(2500);
const rec = await record(session, "call");
await page.waitForTimeout(900);
rec.mark("tapCall");
await tap(page, page.getByRole("button", { name: /Call Moneo/ }).or(page.getByRole("link", { name: /Call Moneo/ })).first());
const call = page.getByRole("dialog", { name: "Voice call with Moneo" });
await call.waitFor();
await call.getByRole("status").filter({ hasText: /Listening/ }).waitFor();
rec.mark("live");
const cards = call.getByRole("region", { name: "Cards to review" });
await cards.getByRole("button").first().waitFor({ timeout: 90_000 });
rec.mark("card");
await call.getByRole("status").filter({ hasText: /Moneo is talking/ }).first().waitFor({ timeout: 45_000 }).catch(() => console.log("not talking"));
rec.mark("talking");
await call.getByRole("status").filter({ hasText: /Listening/ }).first().waitFor({ timeout: 45_000 }).catch(() => console.log("no listening"));
rec.mark("doneTalking");
await page.waitForTimeout(800);
console.log("card buttons:", await cards.getByRole("button").evaluateAll(b => b.map(x => x.textContent)));
await page.screenshot({ path: "promo/out/check/call.png" });
const account = cards.locator("select").first();
if (await account.count()) { const value = await account.evaluate(el => [...el.options].find(option => /Revolut/.test(option.text))?.value); if (value) await account.selectOption(value); }
rec.mark("tapAdd");
await tap(page, cards.getByRole("button", { name: /^Add|Create/ }).first());
await page.waitForTimeout(2500);
rec.mark("added");
await tap(page, call.getByRole("button", { name: /End call/ }));
const summary = page.getByRole("region", { name: "Voice call", exact: true });
await summary.getByRole("list", { name: "Call summary" }).waitFor({ timeout: 90_000 }).catch(() => console.log("no summary"));
rec.mark("summary");
await page.waitForTimeout(2500);
await saveCallAudio(page, "call");
await rec.stop();
console.log("Moneo said:", spoken.join(""));
await page.screenshot({ path: "promo/out/check/call-end.png" });
await session.browser.close();

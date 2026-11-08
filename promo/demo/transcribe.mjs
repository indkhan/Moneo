// Word timings for the recorded call, so captions follow the real voices.
//   node --env-file=../.env demo/transcribe.mjs
import { readFileSync, writeFileSync } from "node:fs";
const dir = "public/rec/call";
const audio = JSON.parse(readFileSync(`${dir}/audio.json`, "utf8")), epoch = JSON.parse(readFileSync(`${dir}/index.json`, "utf8")).epoch;
const out = [];
for (const { who, file, startedAt } of audio) {
  const form = new FormData();
  form.append("file", new Blob([readFileSync(`${dir}/${file.replace(".webm", ".wav")}`)], { type: "audio/wav" }), "call.wav");
  form.append("model", "whisper-1"); form.append("language", "en"); form.append("response_format", "verbose_json"); form.append("timestamp_granularities[]", "word");
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  const { words, text } = await response.json();
  const offset = startedAt / 1000 - epoch;
  console.log(who, text);
  for (const word of words) out.push({ who, word: word.word, start: Math.round((word.start + offset) * 100) / 100, end: Math.round((word.end + offset) * 100) / 100 });
}
writeFileSync("src/call-words.json", JSON.stringify(out.sort((a, b) => a.start - b.start)));
console.log(out.filter(w => w.who === "moneo").map(w => `${w.start}:${w.word}`).join(" "));
console.log(out.filter(w => w.who === "you").map(w => `${w.start}:${w.word}`).join(" "));

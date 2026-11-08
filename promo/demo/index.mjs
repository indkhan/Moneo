// Gathers the recordings' frame times into src/rec.json, so the edit can find any moment of any shot.
//   node demo/index.mjs   (run from promo/)
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const output = {};
for (const shot of readdirSync("public/rec")) {
  const { frames, epoch } = JSON.parse(readFileSync(`public/rec/${shot}/index.json`, "utf8"));
  output[shot] = { t: frames.map(frame => frame.t) };
  if (existsSync(`public/rec/${shot}/audio.json`))
    output[shot].audio = JSON.parse(readFileSync(`public/rec/${shot}/audio.json`, "utf8")).map(({ who, file, startedAt }) => ({ who, file: file.replace(".webm", ".wav"), offset: startedAt / 1000 - epoch }));
}
writeFileSync("src/rec.json", JSON.stringify(output));
console.log(Object.entries(output).map(([shot, value]) => `${shot}: ${value.t.length}`).join(", "));

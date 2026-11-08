// Renders chosen moments as stills for checking a cut: node scripts/stills.mjs <beat> <beat> ...
import { execFileSync } from "node:child_process";
const frames = process.argv.slice(2).map(beat => Math.round(Number(beat) * (60 / 140) * 60));
execFileSync("npx", ["remotion", "render", "MoneoPromo", "out/stills/f", `--frames=${frames.join(",")}`, "--image-format=jpeg", "--muted", "--log=error"], { stdio: "inherit", shell: true });

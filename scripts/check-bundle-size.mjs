// Fails when a page's first-load JavaScript (gzip) grows past its budget in bundle-budget.json.
// Reads the production build in .next, so run `npm run build` first. Prints every page's size.
// After an intended change, `node scripts/check-bundle-size.mjs --update` rewrites the budgets.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";

const next = ".next", budgetFile = "scripts/bundle-budget.json";
// Room for normal churn; a real regression (a library pulled into a page) is far bigger.
const allowedGrowth = 1.1, minimumKb = 5;
const root = JSON.parse(readFileSync(join(next, "build-manifest.json"), "utf8")).rootMainFiles;
const gzipKb = new Map();
const size = file => gzipKb.get(file) ?? gzipKb.set(file, gzipSync(readFileSync(join(next, file))).length / 1024).get(file);

function* manifests(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* manifests(path);
    else if (entry.name === "page_client-reference-manifest.js") yield path;
  }
}

const pages = {};
for (const file of manifests(join(next, "server", "app"))) {
  const route = "/" + relative(join(next, "server", "app"), file).replaceAll("\\", "/").replace(/\/?page_client-reference-manifest\.js$/, "");
  globalThis.__RSC_MANIFEST = {};
  new Function(readFileSync(file, "utf8"))();
  const manifest = Object.values(globalThis.__RSC_MANIFEST)[0];
  const files = new Set([...root, ...Object.values(manifest.entryJSFiles).flat()]);
  pages[route] = Math.round([...files].reduce((total, chunk) => total + size(chunk), 0));
}

const sorted = Object.fromEntries(Object.entries(pages).sort(([a], [b]) => a.localeCompare(b)));
if (process.argv.includes("--update")) {
  writeFileSync(budgetFile, JSON.stringify(sorted, null, 2) + "\n");
  console.log(`Wrote ${Object.keys(sorted).length} page budgets to ${budgetFile}`);
  process.exit(0);
}
const budget = JSON.parse(readFileSync(budgetFile, "utf8"));
const over = [];
for (const [route, kb] of Object.entries(sorted)) {
  const base = budget[route];
  const limit = base === undefined ? undefined : Math.max(Math.round(base * allowedGrowth), base + minimumKb);
  const flag = limit !== undefined && kb > limit ? "  OVER" : "";
  console.log(`${route.padEnd(48)} ${String(kb).padStart(5)} KB${base === undefined ? "  (new page, no budget)" : ` / ${limit} KB${flag}`}`);
  if (flag) over.push(`${route}: ${kb} KB, budget ${limit} KB (baseline ${base} KB)`);
}
if (over.length) {
  console.error(`\nFirst-load JavaScript grew past budget:\n${over.join("\n")}\nIf the growth is intended, run node scripts/check-bundle-size.mjs --update and commit the new budgets.`);
  process.exit(1);
}

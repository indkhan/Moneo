import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { chromium, devices } from "@playwright/test";

const QA_APP = process.env.E2E_BASE_URL ?? "http://localhost:3100";
if (new URL(QA_APP).port === "3000") {
  console.error("Port 3000 is the owner's app. Screenshots come from the QA app only (AGENTS.md Test backend).");
  process.exit(2);
}
const SESSION = process.env.E2E_STORAGE_STATE ?? "e2e/.auth.json";
const VIEWS = [
  { name: "light", theme: "light", device: devices["Desktop Chrome"] },
  { name: "dark", theme: "dark", device: devices["Desktop Chrome"] },
  { name: "mobile", theme: "light", device: devices["iPhone 13"] },
];

const [label, ...names] = process.argv.slice(2);
if (!label || !names.length || !/^[a-z0-9-]+$/.test(label) || names.some(name => /^[a-z]:|\s/i.test(name))) {
  console.error("Usage: npm run qa:shots -- <label> <page> [<page> ...]\n  label: before, after or another lowercase name\n  page: home, or a path without its leading slash (Git Bash rewrites /paths)\n  example: npm run qa:shots -- before home money/transactions");
  process.exit(2);
}
const pages = names.map(name => name === "home" ? "/" : `/${name.replace(/^\/+/, "")}`);
if (!existsSync(SESSION)) {
  console.error(`No QA session at ${SESSION}. Run \`npm run setup -- --qa\` and \`npm run qa:auth\` first.`);
  process.exit(2);
}

const folder = path.join(".qa", "shots", label);
mkdirSync(folder, { recursive: true });
const browser = await chromium.launch();
let failed = false;
try {
  for (const view of VIEWS) {
    const context = await browser.newContext({ ...view.device, baseURL: QA_APP, storageState: SESSION, extraHTTPHeaders: { "x-moneo-test": "1" }, reducedMotion: "reduce", colorScheme: view.theme });
    await context.addCookies([{ name: "moneo-theme", value: view.theme, url: QA_APP }]);
    const tab = await context.newPage();
    const problems = [];
    tab.on("pageerror", error => problems.push(error.message));
    tab.on("console", message => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) problems.push(message.text()); });
    tab.on("response", reply => { if (reply.status() >= 400) problems.push(`${reply.status()} ${reply.request().method()} ${new URL(reply.url()).pathname}`); });
    for (const page of pages) {
      problems.length = 0;
      const response = await tab.goto(page, { waitUntil: "networkidle" }).catch(error => { problems.push(error.message); return null; });
      const slug = page === "/" ? "home" : page.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-");
      const file = path.join(folder, `${slug}-${view.name}.png`);
      if (response) await tab.screenshot({ path: file, fullPage: true });
      const status = response?.status() ?? 0;
      if (!response || status >= 400 || problems.length) failed = true;
      console.log(`${status || "ERR"}  ${file}${problems.length ? `\n     ${[...new Set(problems)].join("\n     ")}` : ""}`);
    }
    await context.close();
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);

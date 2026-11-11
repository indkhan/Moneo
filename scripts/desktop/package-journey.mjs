// The owner's first hour, on the PACKAGED app, with synthetic data and no real providers:
// first-run setup → Home → import a CSV → transactions → undo → re-import → Settings connections
// (sign-ins go to the system browser) → loopback callbacks → close to tray and reopen.
// Records the run as a WebM video (Playwright's bundled ffmpeg encodes VP8 only).
//   node scripts/desktop/package-journey.mjs [--video <file.webm>] [path to the executable]
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { request as httpsRequest, createServer as createHttpsServer } from "node:https";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { alive, check, defaultExe, Desktop, freePort, listeningPid, summary, transactionsText, until } from "./harness.mjs";

const args = process.argv.slice(2);
const videoAt = args.indexOf("--video");
const video = videoAt >= 0 ? path.resolve(args.splice(videoAt, 2)[1]) : null;
const exe = path.resolve(args[0] ?? defaultExe());
if (!existsSync(exe)) { console.error(`No packaged app at ${exe}.`); process.exit(1); }

// Synthetic statement (the e2e fixture AUGUST_CSV plus a few rows); no real data.
const CSV = ["date,description,amount", "2026-08-01,Salary Acme,2500.00", "2026-08-02,AMZN MKTP DE,-42.99", "2026-08-03,Bakery Corner,-6.40", "2026-08-05,City Transit Pass,-49.00", ""].join("\n");

// --- Video: every window's screencast on one timeline, title cards while no window is visible.
class Recorder {
  frames = [];
  sessions = new Set();
  async attach(page) {
    if (!video || this.sessions.has(page)) return;
    this.sessions.add(page);
    const session = await page.context().newCDPSession(page);
    session.on("Page.screencastFrame", ({ data, sessionId }) => {
      this.frames.push({ at: Date.now(), jpeg: Buffer.from(data, "base64") });
      session.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    });
    await session.send("Page.startScreencast", { format: "jpeg", quality: 75, maxWidth: 1280, maxHeight: 800 });
  }
  async card(text, ms = 2_500) {
    if (!video) return;
    this.cardBrowser ??= await chromium.launch();
    const page = await this.cardBrowser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.setContent(`<body style="margin:0;display:grid;place-items:center;height:100vh;background:#0f1011;color:#ececec;font:600 34px system-ui,sans-serif;text-align:center"><div style="max-width:900px">${text}</div></body>`);
    const jpeg = await page.screenshot({ type: "jpeg", quality: 85 });
    await page.close();
    const start = Date.now();
    this.frames.push({ at: start, jpeg, until: start + ms });
    await new Promise(resolve => setTimeout(resolve, ms));
  }
  async write() {
    if (!video || !this.frames.length) return null;
    await this.cardBrowser?.close();
    const ffmpegDir = readdirSync(path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".cache"), "ms-playwright")).find(name => name.startsWith("ffmpeg-"));
    const ffmpeg = path.join(process.env.LOCALAPPDATA, "ms-playwright", ffmpegDir, process.platform === "win32" ? "ffmpeg-win64.exe" : "ffmpeg-linux");
    const fps = 8, frames = this.frames.sort((a, b) => a.at - b.at);
    const encoder = spawn(ffmpeg, ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "pipe:0",
      "-vf", "scale=1280:800:force_original_aspect_ratio=decrease,pad=1280:800:(ow-iw)/2:(oh-ih)/2:color=0x0f1011",
      "-c:v", "libvpx", "-b:v", "1500k", "-deadline", "realtime", "-cpu-used", "8", video], { stdio: ["pipe", "inherit", "inherit"] });
    // A constant frame rate: each tick shows the newest frame so far (a title card holds for its duration).
    let index = 0, current = frames[0];
    for (let at = frames[0].at; at <= frames.at(-1).at + 1_000; at += 1000 / fps) {
      while (index < frames.length && frames[index].at <= at) {
        if (!(current.until && current.until > at && !frames[index].until)) current = frames[index];
        index++;
      }
      if (!encoder.stdin.write(current.jpeg)) await new Promise(resolve => encoder.stdin.once("drain", resolve));
    }
    encoder.stdin.end();
    const code = await new Promise(resolve => encoder.on("exit", resolve));
    return code === 0 ? video : null;
  }
}

const recorder = new Recorder();
const app = new Desktop(exe, "journey");

try {
  await app.launch();
  const setup = await app.setupPage();
  await recorder.attach(setup);
  check("first run: setup window explains the private database", /private database/i.test(await setup.locator("#intro").innerText()));
  let page = await app.appPage();
  await recorder.attach(page);
  const port = Number(new URL(page.url()).port), origin = `http://localhost:${port}`;
  await page.waitForLoadState("networkidle").catch(() => {});
  check("Home opens signed in", new URL(page.url()).pathname === "/" && await page.getByRole("navigation").first().isVisible());
  await page.waitForTimeout(1_500);

  // Import through the page, choosing the columns by hand (no AI is set up).
  const importOnce = async () => {
    await page.goto(`${origin}/import`);
    await page.getByLabel("Financial statement files").waitFor();
    await until("the file picker", async () => page.getByLabel("Financial statement files").isEnabled(), 30_000);
    await page.getByLabel("Financial statement files").setInputFiles({ name: "synthetic-august.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) });
    await page.getByText("Automatic interpretation unavailable. Choose the columns below.", { exact: true }).waitFor({ timeout: 30_000 });
    await page.getByLabel("Account name", { exact: true }).fill("Everyday account");
    await page.getByRole("combobox", { name: "Date", exact: true }).selectOption("date");
    await page.getByRole("combobox", { name: "Description", exact: true }).selectOption("description");
    await page.getByRole("combobox", { name: "Amount", exact: true }).selectOption("amount");
    await page.getByRole("combobox", { name: "Number format in your file" }).selectOption("decimal-dot");
    await page.getByRole("button", { name: "Preview correction", exact: true }).click();
    await page.getByText("4 rows", { exact: true }).waitFor({ timeout: 30_000 });
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "Start import", exact: true }).click();
    const history = page.getByRole("region", { name: "Import history" }).locator("article").filter({ hasText: "synthetic-august.csv" }).first();
    await until("the import to complete", async () => (await history.getByRole("status").innerText()).trim().toLowerCase() === "completed", 120_000);
    await page.waitForTimeout(1_000);
    return history;
  };
  let history = await importOnce();
  check("import a synthetic CSV statement", true);
  let transactions = await transactionsText(page);
  check("transactions show the imported rows", transactions.includes("Salary Acme") && transactions.includes("AMZN MKTP DE"));
  await page.waitForTimeout(1_500);

  await page.goto(`${origin}/import`);
  history = page.getByRole("region", { name: "Import history" }).locator("article").filter({ hasText: "synthetic-august.csv" }).first();
  await history.getByRole("button", { name: "Undo import", exact: true }).click();
  await history.getByRole("button", { name: /^Confirm undo 4 transactions$/ }).click();
  await until("the import to disappear", async () => await history.count() === 0, 30_000);
  await page.waitForTimeout(1_000);
  transactions = await transactionsText(page);
  check("undo removes the imported transactions", !transactions.includes("Salary Acme"));

  await importOnce();
  transactions = await transactionsText(page);
  check("re-importing the same file brings them back", transactions.includes("Salary Acme") && transactions.includes("City Transit Pass"));

  // Settings: connections. Sign-ins open in the system browser (logged here), never in the window.
  await page.goto(`${origin}/settings#connections`);
  await page.waitForLoadState("networkidle").catch(() => {});
  const sections = { ai: "#ai-access", banks: "#banks", scalable: "#scalable", phone: "#phone" };
  const present = Object.fromEntries(await Promise.all(Object.entries(sections).map(async ([name, selector]) => [name, await page.locator(selector).count() > 0])));
  check("Settings shows AI, bank, Scalable and phone sections", Object.values(present).every(Boolean), JSON.stringify(present));
  await page.locator("#ai-access").scrollIntoViewIfNeeded();
  await page.waitForTimeout(1_000);
  const logged = app.external().length;
  await page.getByRole("button", { name: "Sign in with ChatGPT" }).click();
  const chatgpt = await until("ChatGPT sign-in in the system browser", async () => app.external().slice(logged).split("\n").find(url => url.startsWith("https://")), 20_000).catch(() => null);
  check("ChatGPT sign-in opens in the system browser", chatgpt && new URL(chatgpt).hostname.endsWith("openai.com") && new URL(page.url()).hostname === "localhost", chatgpt ? new URL(chatgpt).origin + new URL(chatgpt).pathname : "nothing logged");
  check("ChatGPT sign-in returns to this app's loopback port", chatgpt && new URL(chatgpt).searchParams.get("redirect_uri") === `http://127.0.0.1:${port}/api/ai/chatgpt/callback`);
  await page.goto(`${origin}/settings#scalable`);
  await page.locator("#scalable").scrollIntoViewIfNeeded();
  // Exercise the UI handoff without registering a real client with Scalable.
  const mockScalableUrl = "https://example.com/moneo-qa-scalable-authorize";
  await page.route("**/api/scalable/connect", route => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ url: mockScalableUrl }),
  }));
  const scalable = page.locator("#scalable").getByRole("button", { name: "Connect Scalable Capital" });
  if (await scalable.count() && await scalable.isEnabled()) {
    const mark = app.external().length;
    await scalable.click();
    const url = await until("Scalable in the system browser", async () => app.external().slice(mark).split("\n").find(line => line.startsWith("https://")), 20_000).catch(() => null);
    check("Scalable UI handoff opens the mocked URL in the system browser (provider and callback not exercised)", url === mockScalableUrl, url ? new URL(url).origin : "nothing logged");
  } else console.log("SKIP Scalable connect — the button is disabled without Scalable configured");
  // A full navigation clears the canceled external sign-in navigation before scrolling.
  await page.goto(`${origin}/settings`, { waitUntil: "domcontentloaded" });
  await page.locator("#banks").scrollIntoViewIfNeeded();
  await page.waitForTimeout(1_000);
  const bankButton = page.locator("#banks").getByRole("button", { name: "Connect bank" });
  console.log(`SKIP bank connect — ${await bankButton.count() ? (await bankButton.isEnabled() ? "enabled (not clicked: it calls Enable Banking)" : "the button is disabled without Enable Banking keys") : "no Connect bank button without Enable Banking keys"}`);

  // The sign-in callbacks reach this Moneo.
  const callback = await fetch(`http://127.0.0.1:${port}/api/ai/chatgpt/callback`, { redirect: "manual" });
  check("ChatGPT's loopback callback reaches Moneo", callback.status >= 300 && callback.status < 400 && /\/settings\?chatgpt=/.test(callback.headers.get("location") ?? ""), `${callback.status} → ${callback.headers.get("location")}`);
  const data = path.join(app.home, "data"), ca = readFileSync(path.join(app.home, "mkcert", "rootCA.pem"));
  const key = readFileSync(path.join(data, "localhost-key.pem")), cert = readFileSync(path.join(data, "localhost.pem"));
  const verify = (requestPort, requestPath) => new Promise((resolve, reject) => httpsRequest({ host: "127.0.0.1", servername: "localhost", port: requestPort, path: requestPath, ca }, response => { response.resume(); resolve(response); }).on("error", reject).end());
  const holder = listeningPid(3443);
  const ours = holder && app.snapshot().some(row => row.pid === holder);
  if (ours) {
    const response = await verify(3443, "/api/bank/callback?x=1");
    check("the bank return address (https://localhost:3443) reaches Moneo", response.statusCode === 303 && response.headers.location === `${origin}/api/bank/callback?x=1`, `${response.statusCode} → ${response.headers.location}`);
  } else {
    console.log(`SKIP https://localhost:3443 — port held by another program (pid ${holder}), so this Moneo's listener is off: ${/Bank return listener on port 3443 is off/.test(app.log("next.log"))}`);
    // The certificate itself: valid for localhost under Moneo's own authority (not installed as trusted).
    const server = createHttpsServer({ key, cert }, (_request, response) => response.writeHead(204).end());
    const testPort = await freePort();
    await new Promise(resolve => server.listen(testPort, "127.0.0.1", resolve));
    const response = await verify(testPort, "/").finally(() => server.close());
    check("the bank return certificate is valid for localhost under Moneo's own authority", response.statusCode === 204);
  }

  // Close to the tray, reopen with a second launch.
  if (process.platform === "win32") {
    await page.goto(`${origin}/`);
    await page.waitForTimeout(1_500);
    const handle = app.mainWindow();
    app.closeWindow(handle);
    await until("the window to hide", async () => !app.windowVisible(handle), 10_000);
    const answering = (await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { authorization: "Bearer journey" } })).ok;
    await recorder.card(`Window closed: Moneo keeps running in the tray<br><span style="font-weight:400;font-size:22px;color:#9a9aa0">server still answering: ${answering ? "yes" : "no"}</span>`);
    check("closed window: Moneo keeps running", answering);
    await app.second([]);
    check("opening Moneo again shows the window", await until("the window", async () => app.windowVisible(handle), 10_000).catch(() => false));
    await recorder.card("Opened again from the tray (second launch)", 1_500);
    await page.reload();
    await page.waitForTimeout(2_000);
  }

  app.snapshot();
  await app.quit();
  const left = [...app.seen.values()].filter(row => alive(row.pid));
  check("quit stops every process", left.length === 0, left.map(row => `${row.name}#${row.pid}`).join(", "));
} catch (error) {
  check("journey run", false, error.message);
} finally {
  await app.cleanup();
  const written = await recorder.write().catch(error => { console.log(`video failed: ${error.message}`); return null; });
  if (video) console.log(written ? `video: ${written}` : "video: not written");
}

process.exit(summary() ? 1 : 0);

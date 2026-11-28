import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { chromium } from "@playwright/test";
import postgres from "postgres";

const [base, label, runsArg] = process.argv.slice(2);
if (!base || !label) throw new Error("usage: node scripts/perf-interactions.mjs <baseUrl> <label> [runs]");
const target = new URL(base);
if (target.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(target.hostname) || !target.port || target.port === "3000") {
  throw new Error("Use a local QA server started with --mock-ai.");
}
const auth = await fetch(new URL("/api/health", target), { headers: { "x-moneo-test": "1" }, redirect: "error" });
if (auth.status !== 401) throw new Error("The timing server must require a QA session.");
const { SUPABASE_DB_URL, E2E_USER_EMAIL } = parseEnv(readFileSync(".env.qa", "utf8"));
const dbUrl = new URL(SUPABASE_DB_URL);
if (!["localhost", "127.0.0.1"].includes(dbUrl.hostname) || dbUrl.port !== "54522") throw new Error("The timing script requires the local QA database.");

const runs = Number(runsArg ?? 3);
const db = postgres(SUPABASE_DB_URL, { max: 1, onnotice: () => {} });
const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
const out = {};
try {
const preflight = await browser.newContext({ baseURL: base, storageState: "e2e/.auth.json", extraHTTPHeaders: { "x-moneo-test": "1" } });
const health = await preflight.request.get("/api/health", { maxRedirects: 0 });
if (!health.ok() || (await health.json()).qaMockAi !== true) throw new Error("Start QA with --mock-ai and refresh its session with npm run qa:auth.");
await preflight.close();
const [qaWorkspace] = await db`select w.id from public.workspaces w join auth.users u on u.id=w.owner_id where u.email=${E2E_USER_EMAIL} and u.raw_user_meta_data->>'qa_test' = 'e2e-auth'`;
if (!qaWorkspace) throw new Error("No QA workspace found. Run npm run qa:auth first.");
const { id: workspace } = qaWorkspace;

const median = values => { const sorted = values.filter(v => v != null).sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; };
const open = async (viewport = { width: 1440, height: 900 }) => {
  const context = await browser.newContext({ viewport, baseURL: base, storageState: "e2e/.auth.json", permissions: ["microphone"], extraHTTPHeaders: { "x-moneo-test": "1" } });
  return { context, page: await context.newPage() };
};

{
  const times = [];
  for (let run = -1; run < runs; run++) {
    const { context, page } = await open();
    await page.goto("/ai/activity"); await page.waitForLoadState("load"); await page.waitForTimeout(1500);
    const start = Date.now();
    await page.getByRole("button", { name: "Ask Moneo", exact: true }).click();
    await page.getByRole("dialog", { name: "AI assistant" }).getByLabel("Question").waitFor();
    if (run >= 0) times.push(Date.now() - start);
    await context.close();
  }
  out.panelOpenMs = median(times);
}

let conversationId;
{
  const headers = [], first = [], full = [];
  const { context, page } = await open();
  await page.goto("/ai?conversation=new"); await page.waitForLoadState("load");
  for (let run = -1; run < runs; run++) {
    const timing = await page.evaluate(async () => {
      const conversationId = crypto.randomUUID(), t0 = performance.now();
      const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/x-ndjson, application/json" },
        body: JSON.stringify({ conversationId, requestId: crypto.randomUUID(), message: "In one short sentence: what can you help me with?" }) });
      const tHeaders = performance.now() - t0;
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let tFirst = null, text = "", status = response.status;
      for (;;) {
        const { value, done } = await reader.read();
        if (value && tFirst === null) tFirst = performance.now() - t0;
        text += value ?? "";
        if (done) break;
      }
      const last = text.trim().split("\n").pop();
      return { conversationId, tHeaders, tFirst, tFull: performance.now() - t0, status, result: last.slice(0, 120), synthetic: text.includes("Synthetic QA reply.") };
    });
    if (run === -1) console.log("chat sample:", timing.status, timing.result);
    if (timing.status !== 200 || !timing.synthetic) throw new Error("Chat did not return a synthetic QA reply.");
    if (run >= 0) { headers.push(timing.tHeaders); first.push(timing.tFirst); full.push(timing.tFull); conversationId = timing.conversationId; }
  }
  await context.close();
  out.chatHeadersMs = median(headers); out.chatFirstEventMs = median(first); out.chatFullMs = median(full);
}

{
  const { context, page } = await open();
  await page.goto("/ai"); await page.waitForLoadState("load");
  const samples = await page.evaluate(async id => {
    const times = []; let bytes = 0;
    for (let index = 0; index < 12; index++) { const t0 = performance.now(); const body = await (await fetch(`/api/conversations/${id}`, { cache: "no-store" })).text(); times.push(performance.now() - t0); bytes = body.length; }
    return { times: times.slice(2), bytes };
  }, conversationId);
  out.historyMs = median(samples.times); out.historyBytes = samples.bytes;
  await context.close();
}

{
  const times = [], longTasks = [], shifts = [];
  for (let run = -1; run < runs; run++) {
    const { context, page } = await open();
    await page.goto("/ai?conversation=new"); await page.waitForLoadState("load"); await page.waitForTimeout(1000);
    await page.evaluate(() => { window.__rec = { long: 0, cls: 0 };
      new PerformanceObserver(list => { window.__rec.long += list.getEntries().length; }).observe({ type: "longtask" });
      new PerformanceObserver(list => { for (const e of list.getEntries()) window.__rec.cls += e.value; }).observe({ type: "layout-shift" }); });
    const mic = page.getByRole("button", { name: /^Talk/ });
    if (!await mic.count()) { await context.close(); out.micToRecordingMs = null; break; }
    const start = Date.now();
    await mic.click();
    await page.getByRole("button", { name: /^Done/ }).and(page.locator(":enabled")).waitFor({ timeout: 20_000 });
    if (run >= 0) times.push(Date.now() - start);
    await page.waitForTimeout(5000);
    const rec = await page.evaluate(() => window.__rec);
    if (run >= 0) { longTasks.push(rec.long); shifts.push(rec.cls); }
    await context.close();
  }
  if (times.length) { out.micToRecordingMs = median(times); out.recordingLongTasks = median(longTasks); out.recordingCls = median(shifts); }
}

async function count(page, path, match, hidden = false) {
  let requests = 0;
  page.on("request", request => { if (match(request.url())) requests++; });
  await page.goto(path); await page.waitForLoadState("load"); await page.waitForTimeout(1500);
  requests = 0;
  if (hidden) await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForTimeout(12_000);
  return requests;
}
{
  const isChat = url => url.includes(`/api/conversations/${conversationId}`);
  const requestId = crypto.randomUUID();
  const polling = {};
  try {
    const idle = await open(); polling.chatIdle = await count(idle.page, `/ai?conversation=${conversationId}`, isChat); await idle.context.close();
    await db`insert into public.chat_requests(id, workspace_id, conversation_id, message, status) values (${requestId}, ${workspace}, ${conversationId}, 'perf probe', 'running')`;
    const chat = await open(); polling.chatRunning = await count(chat.page, `/ai?conversation=${conversationId}`, isChat); await chat.context.close();
    const chatHidden = await open(); polling.chatRunningHiddenTab = await count(chatHidden.page, `/ai?conversation=${conversationId}`, isChat, true); await chatHidden.context.close();
  } finally {
    await db`delete from public.chat_requests where id=${requestId}`;
  }
  out.pollingRequestsPer12s = polling;
}
} finally {
  await browser.close(); await db.end();
}
mkdirSync(".qa", { recursive: true });
writeFileSync(`.qa/interactions-${label}.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));

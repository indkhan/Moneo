// Interaction measurements against a running production build (see scripts/perf-pages.mjs for setup).
//   node --env-file=.env scripts/perf-interactions.mjs <baseUrl> <label> [runs=3]
// Costs a few real chat answers (default OpenAI chat model) and, on builds with voice, one realtime transcription session.
//   panel      click on Ask Moneo until the panel dialog is open
//   chat       POST /api/chat with a simple question: response headers, first stream event, full answer
//   history    GET /api/conversations/:id (what loadConversation costs, and what a poll costs)
//   mic        tap on the mic until the recording view is ready (fake microphone; branches with voice only)
//   recording  long tasks (over 50 ms) and layout shift while 5 s of live transcription runs
//   polling    requests per 12 s with a request running in the background, a hidden tab, and nothing running
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import postgres from "postgres";

const [base, label, runsArg] = process.argv.slice(2);
if (!base || !label) throw new Error("usage: node scripts/perf-interactions.mjs <baseUrl> <label> [runs]");
const runs = Number(runsArg ?? 3);
const db = postgres(process.env.SUPABASE_DB_URL, { max: 1, onnotice: () => {} });
const [{ workspace_id: workspace }] = await db`select w.id as workspace_id from public.workspaces w join auth.users u on u.id=w.owner_id where u.email=${process.env.E2E_USER_EMAIL}`;
// The QA user's chat model may be an OpenRouter id without credits; the default OpenAI model works.
await db`update public.workspace_settings set ai_models = ai_models - 'chat' where workspace_id=${workspace}`;

const median = values => { const sorted = values.filter(v => v != null).sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; };
const out = {};
const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
const open = async (viewport = { width: 1440, height: 900 }) => {
  const context = await browser.newContext({ viewport, baseURL: base, storageState: "e2e/.auth.json", permissions: ["microphone"] });
  return { context, page: await context.newPage() };
};

// Ask Moneo panel.
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

// Chat answer, from the page so cookies and headers are the app's own.
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
      return { conversationId, tHeaders, tFirst, tFull: performance.now() - t0, status, result: last.slice(0, 120) };
    });
    if (run === -1) console.log("chat sample:", timing.status, timing.result);
    if (run >= 0) { headers.push(timing.tHeaders); first.push(timing.tFirst); full.push(timing.tFull); conversationId = timing.conversationId; }
  }
  await context.close();
  out.chatHeadersMs = median(headers); out.chatFirstEventMs = median(first); out.chatFullMs = median(full);
}

// loadConversation: the API a chat open and each poll go through.
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

// Mic tap to recording view.
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
    await page.getByRole("button", { name: /^Done/ }).and(page.locator(":enabled")).waitFor({ timeout: 20_000 }).catch(() => {});
    if (run >= 0) times.push(Date.now() - start);
    await page.waitForTimeout(5000);
    const rec = await page.evaluate(() => window.__rec);
    if (run >= 0) { longTasks.push(rec.long); shifts.push(rec.cls); }
    await context.close();
  }
  if (times.length) { out.micToRecordingMs = median(times); out.recordingLongTasks = median(longTasks); out.recordingCls = median(shifts); }
}

// Background polling: requests during 12 s on a chat and on the artifacts page, with and without a running job.
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
  const isRsc = url => url.includes("_rsc=") || url.includes("/ai/artifacts");
  const requestId = crypto.randomUUID();
  const [{ id: build }] = await db`insert into public.artifact_builds(workspace_id, prompt) values (${workspace}, 'perf probe') returning id`;
  const polling = {};
  try {
    const idle = await open(); polling.chatIdle = await count(idle.page, `/ai?conversation=${conversationId}`, isChat); await idle.context.close();
    const artifactsIdle = await open();
    await db`update public.artifact_builds set status='completed' where id=${build}`;
    polling.artifactsIdle = await count(artifactsIdle.page, "/ai/artifacts", isRsc); await artifactsIdle.context.close();
    await db`update public.artifact_builds set status='running', created_at=now() where id=${build}`;
    await db`insert into public.chat_requests(id, workspace_id, conversation_id, message, status) values (${requestId}, ${workspace}, ${conversationId}, 'perf probe', 'running')`;
    const chat = await open(); polling.chatRunning = await count(chat.page, `/ai?conversation=${conversationId}`, isChat); await chat.context.close();
    const chatHidden = await open(); polling.chatRunningHiddenTab = await count(chatHidden.page, `/ai?conversation=${conversationId}`, isChat, true); await chatHidden.context.close();
    const artifacts = await open(); polling.artifactsRunning = await count(artifacts.page, "/ai/artifacts", isRsc); await artifacts.context.close();
    const artifactsHidden = await open(); polling.artifactsRunningHiddenTab = await count(artifactsHidden.page, "/ai/artifacts", isRsc, true); await artifactsHidden.context.close();
  } finally {
    await db`delete from public.chat_requests where id=${requestId}`;
    await db`delete from public.artifact_builds where id=${build}`;
  }
  out.pollingRequestsPer12s = polling;
}
await browser.close(); await db.end();
mkdirSync(".qa", { recursive: true });
writeFileSync(`.qa/interactions-${label}.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));

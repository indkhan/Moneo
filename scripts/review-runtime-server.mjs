// Synthetic boundary server + isolated Next app, managed by Playwright. No .env is loaded.
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(".qa/mne020-runtime");
function write(path, value) { mkdirSync(resolve(root, path, ".."), { recursive: true }); writeFileSync(resolve(root, path), value); }
for (const path of ["workflows/financial-review.ts", "lib/finance/start-review.ts", "lib/settings.ts"]) {
  const baseline = process.env.MNE020_RUNTIME_BASELINE;
  write(path, baseline && path !== "lib/settings.ts" ? execFileSync("git", ["show", `${baseline}:${path}`], {encoding: "utf8"}) : readFileSync(path, "utf8"));
}
write("package.json", JSON.stringify({ private: true, type: "module" }));
write("next.config.mjs", `import { withWorkflow } from 'workflow/next'; export default withWorkflow({ turbopack: { root: ${JSON.stringify(resolve("."))} } });`);
write("tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", lib: ["dom", "esnext"], strict: true, esModuleInterop: true, module: "esnext", moduleResolution: "bundler", jsx: "react-jsx", paths: { "@/*": ["./*"] } } }));
write("app/layout.tsx", `export default function Layout({children}: {children: React.ReactNode}) { return <html><body>{children}</body></html>; }`);
write("app/page.tsx", `export default function Page() { return <p>Synthetic Workflow acceptance</p>; }`);
write("lib/finance/review-loader.ts", `import type { SupabaseClient } from '@supabase/supabase-js';
export async function loadFinancialReviewEvidence(_db: SupabaseClient, workspace: {id: string}) {
 const response = await fetch('http://127.0.0.1:3041/evidence/' + workspace.id);
 if (!response.ok) throw new Error('Synthetic evidence failure');
 return response.json();
}`);
write("lib/ai/provider.ts", `import { MockLanguageModelV3 } from 'ai/test'; import { APICallError } from 'ai';
export async function modelForSettings(settings: {openrouter_model: string | null}) {
 return new MockLanguageModelV3({doGenerate: async () => {
  const response = await fetch('http://127.0.0.1:3041/provider/' + settings.openrouter_model);
  if (!response.ok) throw new APICallError({message: 'Synthetic provider failure', url: 'http://127.0.0.1:3041/provider', requestBodyValues: {}, statusCode: response.status});
  return { content: [{type: 'text', text: 'Synthetic review'}], finishReason: {unified: 'stop', raw: undefined}, usage: {inputTokens: {total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0}, outputTokens: {total: 1, text: 1, reasoning: 0}}, warnings: [] };
 }});
}`);
write("app/api/reviews/route.ts", `import { createClient } from '@supabase/supabase-js';
import { startFinancialReview } from '@/lib/finance/start-review';
import { financialReview } from '@/workflows/financial-review';
import { start, getRun } from 'workflow/api';
export async function POST(request: Request) {
 const input = await request.json();
 try {
  if (input.direct) { const run = await start(financialReview, [input.job, input.workspace]); return Response.json({runId: run.runId}); }
  const db = createClient('http://127.0.0.1:3041', 'synthetic');
  if (input.interruptBeforeStart) { await db.rpc('start_financial_review', {p_request_id: input.request, p_chat_request_id: null}); return Response.json({interrupted: true}, {status: 503}); }
  const result = await startFinancialReview(db, input.workspace, input.request);
  if (input.loseResponse) await new Promise(resolve => setTimeout(resolve, 1500));
  return Response.json(result);
 } catch { return Response.json({error: 'Synthetic dispatch failure'}, {status: 503}); }
}
export async function GET(request: Request) {
 try { return Response.json({status: await getRun(new URL(request.url).searchParams.get('run')!).status}); }
 catch { return Response.json({error: 'Runtime unavailable'}, {status: 503}); }
}`);

const fixtures = new Map();
const byWorkspace = id => [...fixtures.values()].find(item => item.workspace_id === id);
const server = createServer(async (request, response) => {
  let raw = ""; for await (const chunk of request) raw += chunk;
  const body = raw ? JSON.parse(raw) : null;
  const url = new URL(request.url, "http://127.0.0.1:3041");
  const send = (value, code = 200) => { response.writeHead(code, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
  if (url.pathname === "/fixture" && request.method === "POST") {
    const fixture = { ...body, kind: "financial_review", workspace_id: body.workspace, status: "queued", stage: "queued", workflow_run_id: null, dispatched_at: null, cancel_requested: false,
      attempts: { evidence: 0, provider: 0, save: 0, write: 0, failure: 0, gathering_evidence: 0 }, saves: 0, runs: [] };
    fixtures.set(body.id, fixture); return send(fixture);
  }
  if (url.pathname.startsWith("/fixture/")) {
    const item = fixtures.get(url.pathname.split("/").at(-1));
    if (request.method === "DELETE") { fixtures.delete(item?.id); return send({ removed: !fixtures.has(item?.id) }); }
    if (request.method === "PATCH") item.mode = body.mode;
    return send(item ?? null);
  }
  if (url.pathname.startsWith("/evidence/") || url.pathname.startsWith("/provider/")) {
    const item = byWorkspace(url.pathname.split("/").at(-1)), stage = url.pathname.split("/")[1];
    item.attempts[stage]++;
    if (stage === "provider" && item.mode === "provider-permanent") return send({error: "Synthetic permanent provider failure"}, 401);
    if (item.mode === stage + "-once" && item.attempts[stage] === 1 || item.mode === stage + "-exhausted" || stage === "evidence" && item.mode.startsWith("failure-write")) return send({error: "Synthetic failure"}, 503);
    if (stage === "provider" && item.mode === "slow-provider") await new Promise(resolve => setTimeout(resolve, 500));
    if (stage === "provider" && item.mode === "cancel-provider") { item.status = "canceled"; item.cancel_requested = true; }
    return send({ period: {from: "2026-10-01", to: "2026-10-06"}, planning: {unavailable: "Synthetic"} });
  }
  if (url.pathname.startsWith("/rest/v1/rpc/")) {
    const name = url.pathname.split("/").at(-1);
    if (name === "start_financial_review") {
      const item = [...fixtures.values()].find(item => item.request === body.p_request_id);
      const started = !item.claimed; item.claimed = true;
      return send({jobId: item.id, status: item.status, started});
    }
    const item = fixtures.get(body.p_job_id);
    if (!item || item.workspace_id !== body.p_workspace_id) return send({code: "P0002", message: "Synthetic missing job"}, 404);
    if (name === "register_financial_review_run") {
      if (!item.runs.includes(body.p_run_id)) item.runs.push(body.p_run_id);
      if (!item.workflow_run_id) { item.workflow_run_id = body.p_run_id; item.dispatched_at = new Date().toISOString(); }
      return send(item.workflow_run_id === body.p_run_id && ["queued", "running"].includes(item.status) && !item.cancel_requested);
    }
    if (name === "fail_financial_review") {
      item.attempts.failure++;
      if (item.mode === "failure-write-once" && item.attempts.failure === 1 || item.mode === "failure-write-exhausted") return send({code: "XX000", message: "Synthetic finalizer write failure"}, 503);
      if (!["completed", "canceled", "failed"].includes(item.status) && (!item.workflow_run_id || item.workflow_run_id === body.p_run_id)) {
        item.workflow_run_id ??= body.p_run_id; item.status = item.cancel_requested ? "canceled" : "failed"; item.stage = body.p_stage; item.error = body.p_error;
      }
      return send(item.status);
    }
    if (name === "finish_financial_review") {
      item.attempts.save++;
      if (item.mode === "save-once" && item.attempts.save === 1 || item.mode === "save-exhausted") return send({code: "XX000", message: "Synthetic save failure"}, 503);
      if (item.mode === "cancel-publication") { item.status = "canceled"; item.cancel_requested = true; }
      if (!["canceled", "failed", "completed"].includes(item.status)) { item.status = "completed"; item.saves++; }
      if (item.mode === "save-lost-response" && item.attempts.save === 1) return send({code: "XX000", message: "Synthetic save response lost after commit"}, 503);
      return send(item.status);
    }
    return send({error: "Unknown synthetic RPC"}, 400);
  }
  if (url.pathname === "/rest/v1/workspace_settings") {
    const item = byWorkspace(url.searchParams.get("workspace_id")?.slice(3));
    return send({ai_data_scopes: item.mode === "permanent" ? [] : ["accounts", "transactions"], timezone: "UTC", openrouter_model: item.workspace_id});
  }
  if (url.pathname === "/rest/v1/workspaces") return send({id: url.searchParams.get("id")?.slice(3), display_currency: "EUR"});
  if (url.pathname === "/rest/v1/background_jobs") {
    const item = fixtures.get(url.searchParams.get("id")?.slice(3));
    if (!item) return send(null);
    if (request.method === "PATCH") {
      item.attempts.write++;
      if (body.stage === "gathering_evidence") item.attempts.gathering_evidence++;
      if (item.mode === "write-once" && item.attempts.write === 1) return send({code: "XX000", message: "Synthetic stage failure"}, 503);
      const matches = [...url.searchParams].every(([key, filter]) => {
        if (key === "select") return true;
        if (filter.startsWith("eq.")) return String(item[key]) === filter.slice(3);
        if (filter.startsWith("in.(")) return filter.slice(4, -1).split(",").includes(item[key]);
        return true;
      });
      if (!matches) return send(null);
      Object.assign(item, body);
    }
    return send(item);
  }
  if (url.pathname === "/rest/v1/summary_runs") return send(null);
  return send({error: "Unknown synthetic endpoint"}, 404);
});
await new Promise(resolve => server.listen(3041, "127.0.0.1", resolve));
const child = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), "dev", root, "--webpack", "--port", "3040"], {
  cwd: root, windowsHide: true, stdio: "inherit", env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:3041", SUPABASE_SERVICE_ROLE_KEY: "synthetic", OPENROUTER_API_KEY: "", WORKFLOW_TARGET_WORLD: "local", WORKFLOW_LOCAL_DATA_DIR: resolve(root, "runtime-data"), WORKFLOW_LOCAL_BASE_URL: "http://localhost:3040", PORT: "3040" },
});
const stop = () => { child.kill(); server.close(); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
child.on("exit", code => { server.close(); process.exitCode = code ?? 1; });

// Opt-in synthetic HTTP boundaries. All request/controller/read/receipt/workflow/UI code is copied unchanged.
// This verifies installed local runtime behavior, not Supabase authentication, SQL locks or deployment.
import {cpSync, readFileSync} from "node:fs";
import {resolve} from "node:path";

export function prepareInvestigationRuntime(root, write) {
  cpSync(resolve("lib"), resolve(root, "lib"), {recursive: true});
  for (const path of ["app/api/analysis/route.ts", "app/api/analysis/[id]/route.ts", "app/ai/analysis-panel.tsx", "components/ai-message.tsx", "components/review-verification.tsx"])
    write(path, readFileSync(path, "utf8"));
  write("app/page.tsx", `import {AnalysisPanel} from '@/app/ai/analysis-panel'; export default function Page() {return <AnalysisPanel locale="en-GB" timezone="UTC"/>;}`);
  write("lib/auth.ts", `import {cookies} from 'next/headers'; import {createClient} from '@supabase/supabase-js'; import {loadWorkspaceSettings} from './settings';
export async function requireWorkspace() {
 const id=(await cookies()).get('qa-workspace')?.value; if(!id) throw new Error('Synthetic authentication required');
 const supabase=createClient('http://127.0.0.1:3041','synthetic',{global:{headers:{'x-qa-workspace':id}},auth:{persistSession:false}});
 const settings=await loadWorkspaceSettings(supabase,id);
 return {supabase,workspace:{id,display_currency:'EUR',timezone:'UTC'},settings,user:{id}};
}`);
  write("lib/ai/provider.ts", `import {MockLanguageModelV3} from 'ai/test'; import {APICallError} from 'ai';
export async function modelForSettings(settings: {openrouter_model:string|null}) {
 return new MockLanguageModelV3({doGenerate:async ({abortSignal})=>{
  const response=await fetch('http://127.0.0.1:3041/provider/'+settings.openrouter_model,{signal:abortSignal});
  if(!response.ok)throw new APICallError({message:'Synthetic provider failure',url:response.url,requestBodyValues:{},statusCode:response.status});
  return {content:[{type:'text',text:'{}'}],finishReason:{unified:'stop',raw:undefined},usage:{inputTokens:{total:1,noCache:1,cacheRead:0,cacheWrite:0},outputTokens:{total:1,text:1,reasoning:0}},warnings:[]};
 }});
}`);
}

export async function handleInvestigationRuntime({request, response, body, url, fixtures, send}) {
  const table = url.pathname.split("/").at(-1);
  const workspace = url.searchParams.get("workspace_id")?.replace(/^eq\./, "") ?? request.headers["x-qa-workspace"] ?? body?.workspace_id ?? body?.p_workspace_id;
  const item = [...fixtures.values()].find(value => value.workspace_id === workspace);
  const fail = (message, code = "22023") => send({code, message}, 400);
  const rpcItem = body?.p_job_id ? fixtures.get(body.p_job_id) : item;
  if (url.pathname.startsWith("/rest/v1/rpc/")) {
    if (table === "start_financial_investigation") {
      if (!item) {fail("Unknown synthetic owner", "P0002"); return true;}
      if (item.request && item.request !== body.p_request_id || item.review_request && JSON.stringify(item.review_request) !== JSON.stringify(body.p_specification)) {
        fail("Synthetic investigation identity changed"); return true;
      }
      item.request = body.p_request_id; item.review_request = body.p_specification;
      const started = !item.claimed; item.claimed = true;
      send({jobId: item.id, status: item.status, started}); return true;
    }
    if (["checkpoint_financial_investigation", "reserve_financial_investigation_synthesis"].includes(table)) {
      if (!rpcItem || rpcItem.workspace_id !== body.p_workspace_id) {fail("Unknown scoped job", "P0002"); return true;}
      if (rpcItem.workflow_run_id !== body.p_run_id || rpcItem.cancel_requested || !["queued", "running"].includes(rpcItem.status)) {send(false); return true;}
      if (table === "reserve_financial_investigation_synthesis" && rpcItem.review_progress?.synthesisAttempted) {send(false); return true;}
      rpcItem.review_progress = structuredClone(body.p_progress);
      // Fail after retaining a spent read, so the real durable step retry must count it.
      if (rpcItem.mode === "checkpoint-lost-once" && !rpcItem.lostCheckpoint && body.p_progress.queries.some(query => query.status === "completed")) {
        rpcItem.lostCheckpoint = true; send({code: "XX000", message: "Synthetic checkpoint response lost"}, 503); return true;
      }
      send(true); return true;
    }
    if (table === "finish_financial_investigation") {
      if (!rpcItem || rpcItem.workspace_id !== body.p_workspace_id) {fail("Unknown scoped job", "P0002"); return true;}
      if (rpcItem.workflow_run_id !== body.p_run_id || rpcItem.cancel_requested) {send("canceled"); return true;}
      if (rpcItem.status !== "completed") {
        rpcItem.status = "completed"; rpcItem.saves++;
        rpcItem.analysis = {id: rpcItem.id, title: body.p_title, body: body.p_body, evidence: body.p_evidence, created_at: new Date().toISOString()};
      }
      send(rpcItem.status); return true;
    }
    if (table === "cancel_financial_review") {
      const owned = fixtures.get(body.p_job_id);
      if (!owned || owned.workspace_id !== workspace) {fail("Unknown owned review", "P0002"); return true;}
      owned.cancel_requested = true;
      send("cancel_requested"); return true;
    }
  }
  if (url.pathname === "/rest/v1/workspace_settings") {
    if (!item) {fail("Unknown synthetic owner", "P0002"); return true;}
    send({ai_data_scopes: item.scopes ?? ["accounts", "transactions", "planning"], timezone: "UTC", openrouter_model: item.workspace_id, summary_cadence: "none"}); return true;
  }
  if (url.pathname === "/rest/v1/financial_evidence_receipts") {
    if (!item) {fail("Unknown receipt owner", "P0002"); return true;}
    item.receipts ??= [];
    if (request.method === "POST") {
      if (body.workspace_id !== item.workspace_id) {fail("Foreign receipt", "42501"); return true;}
      if (item.receipts.some(receipt => receipt.id === body.id)) {send({code: "23505", message: "Retained receipt already exists"}, 409); return true;}
      item.receipts.push(body); send(null, 201);
    } else send(item.receipts.find(receipt => receipt.id === url.searchParams.get("id")?.slice(3)) ?? null);
    return true;
  }
  if (url.pathname === "/rest/v1/background_jobs") {
    const id = url.searchParams.get("id")?.slice(3);
    const owned = id ? fixtures.get(id) : item;
    if (id && (!owned || owned.workspace_id !== workspace)) {send(null); return true;}
    if (!id && workspace) {send(item ? [item] : []); return true;}
    // Actual state/run filters and conditional stage updates remain in the shared harness.
  }
  if (url.pathname === "/rest/v1/saved_analyses") {send(item?.analysis ?? null); return true;}
  if (url.pathname.startsWith("/provider/")) {
    const providerItem = [...fixtures.values()].find(value => value.workspace_id === url.pathname.split("/")[2]);
    if (!providerItem) {fail("Unknown synthetic provider owner", "P0002"); return true;}
    providerItem.attempts.provider++;
    if (providerItem.mode === "provider-waits") {
      response.on("close", () => {providerItem.providerAborted = true;});
      return true;
    }
    send({}); return true;
  }
  if (url.pathname.startsWith("/rest/v1/") && ["accounts", "categories", "merchants", "transactions", "effective_transactions", "goals"].includes(table)) {
    if (!item) {fail("Unknown data owner", "P0002"); return true;}
    let rows = table === "effective_transactions" ? item.ledger ?? [] : item[table] ?? [];
    if (table === "effective_transactions") {
      item.ledgerReads = (item.ledgerReads ?? 0) + 1;
      const active = item.review_progress?.queries.at(-1)?.query;
      if (item.mode === "followup-unavailable" && active?.page.groupKey) {send({code: "XX000", message: "Synthetic unavailable follow-up"}, 503); return true;}
      if (item.mode === "deadline-followup" && active?.page.groupKey) {
        response.on("close", () => {item.readAborted = true;}); return true;
      }
      const dates = url.searchParams.getAll("posted_on");
      rows = rows.filter(row => dates.every(filter => filter.startsWith("gte.") ? row.posted_on >= filter.slice(4) : filter.startsWith("lte.") ? row.posted_on <= filter.slice(4) : true));
    }
    if (table === "goals" && url.searchParams.has("id")) rows = rows.filter(row => url.searchParams.get("id").includes(row.id));
    const limit = Number(url.searchParams.get("limit") ?? 500), offset = Number(url.searchParams.get("offset") ?? 0);
    send(rows.slice(offset, offset + limit)); return true;
  }
  return false;
}

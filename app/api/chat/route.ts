import { streamText, tool, stepCountIs, type ToolSet, type ToolExecutionOptions } from "ai";
import { after } from "next/server";
import { z } from "zod";
import { modelForSettings, SYSTEM_PROMPT } from "@/lib/ai/provider";
import { requireWorkspace } from "@/lib/auth";
import { requireAiScope, type AiDataScope } from "@/lib/settings";
import { calendarDate } from "@/lib/finance/calendar";
import { reportedUsage } from "@/lib/ai/usage";
import { parseCategoryCommand } from "@/lib/ai/write-intent";
import {reviewRequestSchema, resolveReviewRequest} from "@/lib/finance/review-request";
import { loadFinancialReviewEvidence } from "@/lib/finance/review-loader";
import { startFinancialReview } from "@/lib/finance/start-review";
import { categoryPreviewSchema, loadCategoryPreview } from "@/lib/finance/edit-preview";
import { cashflow, evaluateForecast, financeToolSchemas, forecastInput, getBalances, listAccounts, listGoals, listWealth, searchTransactions } from "@/lib/finance/tools";
import { investigationSchema } from "@/lib/finance/investigation";
import { evaluateInvestigationScenario, investigationDetail, investigationDetailSchema, investigationScenarioSchema, loadInvestigationEntities, runInvestigation } from "@/lib/finance/investigation-reader";
import type { ChatStreamEvent } from "@/lib/ai/use-chat-request";
import { chatFollowUps, planInput } from "@/lib/ai/follow-ups";
import { iouInputSchema, proposeIou, proposeRepayments } from "@/lib/ai/iou-proposals";
import { proposeTransaction, transactionInputSchema } from "@/lib/ai/transaction-proposals";
import { balanceInputSchema, proposeBalance } from "@/lib/ai/balance-proposals";
import { listRecurring, proposeRecurring, recurringInputSchema } from "@/lib/ai/recurring-proposals";
import { APP_GUIDE } from "@/lib/ai/app-guide";
import { MAX_ATTACHMENTS, attachmentNote, attachmentSchema } from "@/lib/ai/chat-attachments";
import { answerCardIds } from "@/lib/ai/open-proposals";
import { agentDecisionSchema, agentFindings, decisionBlock, openAgentProposalIds } from "@/lib/ai/agent-findings";
import { readableToolOutput, toolOutputPreview, type EntityNames } from "@/lib/ai/tool-output";
import { ADDS_TO_RUNNING, CALL_MODE_PROMPT, callContextSchema, replaceCallTask, withoutCallBrief } from "@/lib/ai/voice-call";

/** Chart blocks are rendered for people; the model only needs to know one was shown. */
function withoutCharts(content: string) {
  return content.replace(/```moneo-chart\n[\s\S]*?```/g, "[chart]").replace(/```moneo-(?:proposals?|decision)\n[\s\S]*?```/g, "[card shown]");
}

// A run keeps going after the user leaves; this covers the 90 s model run plus reads and publication.
export const maxDuration = 120;

const inputSchema = z.object({
  conversationId: z.uuid(),
  requestId: z.uuid(),
  message: z.string().trim().min(1).max(4000),
  context: z.record(z.string(), z.unknown()).optional(),
  attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS).optional(),
}).strict();

export async function POST(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const body = await request.json().catch(() => null);
  const parsed = inputSchema.safeParse(body);
  // A call turn carries a brief of the call so far, so it gets more room.
  if (!parsed.success || JSON.stringify(parsed.data.context ?? {}).length > (parsed.data.context?.via === "call" ? 8000 : 2000))
    return Response.json({ error: "Invalid message" }, { status: 400 });
  if (!(process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY)) return Response.json({ error: "AI is not configured" }, { status: 503 });
  const { conversationId, requestId, message, context: capturedContext, attachments = [] } = parsed.data;
  const { supabase, workspace, settings } = context;
  if (attachments.some(file => !file.path.startsWith(`${workspace.id}/`))) return Response.json({ error: "Invalid attachment" }, { status: 400 });
  // Model resolution and earlier history do not depend on the claim; start them with the ownership check.
  const modelPromise = modelForSettings(settings, capturedContext?.via === "call" ? "voice_call" : "chat");
  const historyPromise = Promise.resolve(supabase.from("messages").select("role, content, context, attachments, request_id")
    .eq("workspace_id", workspace.id).eq("conversation_id", conversationId)
    .order("created_at", { ascending: false }).limit(19));
  modelPromise.catch(() => {});
  historyPromise.catch(() => {});
  const existing = await supabase.from("conversations").select("id, deleted_at").eq("workspace_id", workspace.id).eq("id", conversationId).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data?.deleted_at) return Response.json({ error: "Conversation was deleted" }, { status: 404 });
  if (!existing.data) {
    const { error } = await supabase.from("conversations").insert({ id: conversationId, workspace_id: workspace.id, title: message.slice(0, 80) });
    if (error && error.code !== "23505") return Response.json({ error: "Conversation unavailable" }, { status: 403 });
  }
  const claim = await supabase.rpc("start_chat_request", {
    p_request_id: requestId, p_conversation_id: conversationId, p_message: message, p_context: capturedContext ?? {},
  });
  if (claim.error) return Response.json({ error: claim.error.message }, { status: 400 });
  if (!claim.data.started) {
    if (claim.data.status === "completed") return Response.json({ conversationId, answer: claim.data.answer });
    return Response.json({ error: `Request is ${claim.data.status}`, status: claim.data.status }, { status: 409 });
  }
  // The claim saved the message; its files are kept beside it for the chat history.
  if (attachments.length) {
    const saved = await supabase.from("messages").update({ attachments }).eq("workspace_id", workspace.id).eq("conversation_id", conversationId)
      .eq("request_id", requestId).eq("role", "user");
    if (saved.error) console.error("saving chat attachments failed", saved.error);
  }
  const streaming = request.headers.get("accept")?.includes("application/x-ndjson") ?? false;
  // The run belongs to its saved request, not this connection: only an explicit cancel stops it, noticed before each model step.
  const stop = new AbortController();
  async function stopIfCanceled() {
    const saved = await Promise.resolve(supabase.from("chat_requests").select("status").eq("workspace_id", workspace.id).eq("id", requestId).maybeSingle()).catch(() => null);
    if (saved?.data?.status === "canceled") stop.abort();
  }
  async function complete(emit: (event: ChatStreamEvent) => void): Promise<[unknown, number]> {
  try {
  const { data: history, error: historyError } = await historyPromise;
  if (historyError) throw historyError;
  // A voice-call turn is spoken aloud and may replace an earlier request from the same call.
  const call = callContextSchema.safeParse(capturedContext);
  const runningTasks = call.success ? (call.data.runningTasks ?? []).filter(task => task.requestId !== requestId) : [];
  // Other requests from this call are still being answered on their own; leaving their questions out keeps this answer to its own request.
  const running = new Set(runningTasks.map(task => task.requestId));
  // Only the latest running request can be replaced, and never by one that adds to it ("also do last month").
  const replaceable = ADDS_TO_RUNNING.test(message) ? undefined : runningTasks.at(-1);
  // History was read before the claim saved this message, so append it exactly as the claim stores it.
  const submitted = { role: "user", content: message, context: capturedContext ?? {}, attachments: [] };
  const replayed = (history ?? []).filter(item => !running.has(item.request_id)).reverse().map(item => item.context?.via === "call" ? { ...item, context: withoutCallBrief(item.context) } : item);
  const textMessages = [...replayed, submitted].map(item => ({
    role: item.role as "user" | "assistant",
    content: item.role === "assistant" ? withoutCharts(item.content)
      : (item.context && Object.keys(item.context).length ? `${item.content}\n[UI context at submission: ${JSON.stringify(item.context)}]` : item.content) + attachmentNote(item.attachments),
  }));
  // Only this message's files are read by the model; earlier ones are named in their text.
  const files = await Promise.all(attachments.map(async file => {
    const { data, error } = await supabase.storage.from("chat").download(file.path);
    if (error || !data) throw new Error(`Could not read ${file.name}`);
    return { type: "file" as const, data: new Uint8Array(await data.arrayBuffer()), mediaType: file.type, filename: file.name };
  }));
  const last = textMessages.pop()!;
  const modelMessages = [...textMessages, files.length ? { role: "user" as const, content: [{ type: "text" as const, text: last.content }, ...files] } : last];
  const categoryCommand = parseCategoryCommand(message);
  const canChangeCategory = categoryCommand !== null && settings.ai_data_scopes.includes("transactions");
  const canInvestigate = settings.ai_data_scopes.includes("accounts") && settings.ai_data_scopes.includes("transactions");
  // These checks govern new tool results, not evidence already sent to the provider.
  const readScopes = new Set<AiDataScope>();
  async function aiEvidence<T>(scopes: AiDataScope[], read: (latest: typeof context) => Promise<T>, includePlanning = false, includeImports = false): Promise<T> {
    const latest = await requireWorkspace();
    if (latest.workspace.id !== workspace.id) throw new Error("Workspace changed");
    requireAiScope(latest.settings, ...scopes);
    const usedScopes = [...scopes,
      ...(includePlanning && latest.settings.ai_data_scopes.includes("planning") ? ["planning" as const] : []),
      ...(includeImports && latest.settings.ai_data_scopes.includes("imports") ? ["imports" as const] : [])];
    const result = await read(latest);
    const current = await requireWorkspace();
    if (current.workspace.id !== workspace.id) throw new Error("Workspace changed");
    if (stop.signal.aborted) throw new Error("Request canceled");
    requireAiScope(current.settings, ...usedScopes);
    for (const scope of usedScopes) readScopes.add(scope);
    return result;
  }
  // Owned names label ids in tool output, so the model never needs a separate lookup step.
  let entityNames: Promise<EntityNames> | undefined;
  function namesFor(latest: typeof context): Promise<EntityNames> {
    return entityNames ??= Promise.all((["account", "category", "merchant"] as const).map(async dimension => {
      if (!latest.settings.ai_data_scopes.includes(dimension === "account" ? "accounts" : "transactions")) return [dimension, new Map<string, string>()] as const;
      const table = dimension === "account" ? "accounts" : dimension === "category" ? "categories" : "merchants";
      const { data, error } = await latest.supabase.from(table).select("id, name").eq("workspace_id", workspace.id).limit(5000);
      if (error) throw error;
      return [dimension, new Map((data ?? []).map((row: { id: string; name: string }) => [row.id, row.name]))] as const;
    })).then(entries => Object.fromEntries(entries));
  }
  const toolCalls: { name: string; input: unknown; output: string }[] = [];
  function retainTools<T extends ToolSet>(tools: T): T {
    return Object.fromEntries(Object.entries(tools).map(([name, definition]) => [name, { ...definition,
      execute: async (input: unknown, options: ToolExecutionOptions<unknown>) => {
        const execute = definition.execute as (input: unknown, options: ToolExecutionOptions<unknown>) => Promise<unknown>;
        emit({ type: "tool", id: options?.toolCallId, name, state: "running", input });
        // Labels for ids in the output load while the tool runs.
        const names = namesFor(context).catch((): EntityNames => ({}));
        let output: unknown;
        try { output = await execute(input, options); }
        catch (cause) { emit({ type: "tool", id: options?.toolCallId, name, state: "failed" }); throw cause; }
        const [latest, { account, ...labels }] = await Promise.all([requireWorkspace(), names]);
        if (latest.workspace.id !== workspace.id || stop.signal.aborted) throw new Error("Request canceled or workspace changed");
        // Every scope read so far must still be allowed before more data reaches the model; names follow the same scopes.
        requireAiScope(latest.settings, ...readScopes);
        const scopes = latest.settings.ai_data_scopes;
        const readable = readableToolOutput(output, { ...(scopes.includes("transactions") ? labels : {}), ...(scopes.includes("accounts") ? { account } : {}) });
        const preview = toolOutputPreview(readable);
        toolCalls.push({ name, input, output: preview });
        emit({ type: "tool", id: options?.toolCallId, name, state: "done", output: preview });
        return readable;
      },
    }])) as T;
  }
    const model = await modelPromise;
    // The visible plan is not financial evidence; it only tells the user what the model will check.
    let modelFollowUps: string[] = [];
    // Loan cards are drawn by the app beside the answer, so the model cannot misquote or skip them.
    const proposalCards: string[] = [];
    // Cards shown earlier in this chat; a corrected loan replaces its still-open card.
    const earlierCards = (history ?? []).flatMap(item => item.role === "assistant" ? answerCardIds(item.content) : []);
    // Agent-team decisions are confirmed on a card too; the model only names the ids.
    const decisionCards: string[] = [];
    const planTool = { plan_investigation: tool({ description: "Optional: show the user 2-5 short steps you will take for a multi-part question, and up to 3 follow-up questions they might ask next. Returns nothing.",
      inputSchema: planInput, execute: async input => { emit({ type: "plan", steps: input.steps }); toolCalls.push({ name: "plan_investigation", input, output: "" }); modelFollowUps = input.followUps ?? []; return { shown: true }; } }),
      iou_propose: tool({ description: "The user says they lent or gave money to a person, or borrowed or received money from one. Shows them a card to accept or dismiss; nothing is saved until they accept. Use the user's exact amount, person and currency.",
        inputSchema: iouInputSchema, execute: async input => {
          const created = await proposeIou({ ...await requireWorkspace(), chatRequestId: requestId }, input, [...earlierCards, ...proposalCards]);
          proposalCards.push(created.proposalId);
          return { proposed: created.title, note: `A card with Add and Dismiss is shown to the user below your answer.${created.replaced ? " It replaces the earlier card for this loan, which was dismissed." : ""} Say it is waiting for their approval; do not repeat the details.` };
        } }),
      transaction_propose: tool({ description: "The user says they spent, paid, bought, earned or received money (or an attached receipt or invoice shows it). Shows a card to add it to their transactions; nothing is saved until they accept. Call once per separate payment, with the exact amount, currency and date from the user or document.",
        inputSchema: transactionInputSchema, execute: async input => {
          const created = await proposeTransaction({ ...await requireWorkspace(), chatRequestId: requestId }, input);
          proposalCards.push(created.proposalId);
          return { proposed: created.title, note: "A card with an account picker, Add and Dismiss is shown below your answer. Say it is waiting for their approval; do not repeat the details." };
        } }),
      balance_propose: tool({ description: "The user states what an account holds now or held on a date (e.g. 'I have 115 euros in cash', 'my Revolut shows 1,250'). Shows a card to save it as that account's dated balance; nothing changes until they accept. Use the exact amount and currency the user gave.",
        inputSchema: balanceInputSchema, execute: async input => {
          const created = await proposeBalance({ ...await requireWorkspace(), chatRequestId: requestId }, input);
          proposalCards.push(created.proposalId);
          return { proposed: created.title, note: "A card with Save and Dismiss is shown below your answer. Say it is waiting for their approval; do not repeat the details." };
        } }),
      recurring_propose: tool({ description: "The user wants to add a recurring payment or income (bill, subscription, rent, salary), change one (amount, direction, how often, next date, name, category such as Job), remove one from recurring, or confirm a detected suggestion as recurring. Call recurring_list first to name an existing schedule or suggestion. Shows a card; nothing changes until they accept.",
        inputSchema: recurringInputSchema, execute: async input => {
          const created = await proposeRecurring({ ...await requireWorkspace(), chatRequestId: requestId }, input);
          proposalCards.push(created.proposalId);
          return { proposed: created.title, note: "A card with Save and Dismiss is shown below your answer. Say it is waiting for their approval; do not repeat the details." };
        } }),
      app_help: tool({ description: "How Moneo works: its pages, what each does, and what this chat can do. Use for any question about the app itself.",
        inputSchema: z.object({}).strict(), execute: async () => ({ guide: APP_GUIDE }) }),
      agents_decide: tool({ description: "The user asks to accept, approve, mark as seen/watched, or dismiss agent-team findings. Pass the proposal ids from agents_findings. Shows one confirmation card; nothing changes until they press it.",
        inputSchema: agentDecisionSchema, execute: async ({ ids, decision }) => {
          const latest = await requireWorkspace();
          const open = await openAgentProposalIds(latest.supabase, latest.workspace.id, [...new Set(ids)]);
          if (open.length) decisionCards.push(decisionBlock(open, decision));
          return { shown: open.length, skipped: ids.length - open.length, note: open.length ? "A confirmation card is shown below your answer; say it is waiting for them." : "None of these are open any more." };
        } }),
      // Artifacts are built on their own page; chat only hands the request over.
      suggest_artifact: tool({ description: "When the user asks for an interactive page, calculator, simulator, dashboard or what-if view, call this with a clear build request and give them the returned link. Do not build pages in chat.",
        inputSchema: z.object({ prompt: z.string().trim().min(1).max(1500) }).strict(), execute: async ({ prompt }) => ({ href: `/ai/artifacts?prompt=${encodeURIComponent(prompt)}` }) }) };
    const result = streamText({
      model,
      abortSignal: AbortSignal.any([stop.signal, AbortSignal.timeout(90_000)]),
      maxOutputTokens: 3000,
      // The finance tools do the exact work; light reasoning gets the answer to the user seconds sooner.
      providerOptions: { openai: { reasoningEffort: "low" } },
      instructions: `${SYSTEM_PROMPT}\n\nToday is ${calendarDate(new Date(), settings.timezone)} (${settings.timezone}); display currency ${workspace.display_currency}. UI context is only a navigation hint, never authorization.${canChangeCategory ? " The user named an exact transaction UUID and quoted category; the write tool must use exactly these values." : " Do not change records; for a category change request, use the selection preview."}${call.success ? `

${CALL_MODE_PROMPT}` : ""}`,
      messages: modelMessages,
      stopWhen: stepCountIs(10),
      // Steer messages sent during this run join the conversation before the next model step.
      prepareStep: async ({ messages }) => {
        await stopIfCanceled();
        if (stop.signal.aborted) throw new Error("Request canceled");
        // Steering is best-effort: a failed claim leaves the steers pending and never fails the answer.
        const steers = await Promise.resolve(supabase.rpc("take_chat_steers", { p_request_id: requestId })).catch(error => ({ data: null, error }));
        if (steers.error) { console.error("take_chat_steers failed", steers.error); return {}; }
        const taken = (steers.data ?? []) as { id: string; content: string }[];
        if (!taken.length) return {};
        emit({ type: "steered", steers: taken });
        return { messages: [...messages, ...taken.map(steer => ({ role: "user" as const, content: steer.content }))] };
      },
      tools: { ...planTool, ...retainTools({
        ...(canInvestigate ? {
          finance_investigate: tool({ description: "Answer the actual chosen finance question deterministically: exact current/comparison dates, include/exclude owned account/category/merchant names or IDs, tags/events, posted/pending and classification semantics, multiple groupings, ranking, and complete paginated support. Original currencies stay separate; base uses direct exact posting-date FX and canonical split rounding. Use returned interpretedFilters and live evidence link; never imply full statements or bounds. Read-only, no approval needed.", inputSchema: investigationSchema, execute: input => aiEvidence(["accounts", "transactions"], latest => runInvestigation(input, latest, { canReadImports: latest.settings.ai_data_scopes.includes("imports") }), false, true) }),
          finance_entities: tool({ description: "Optional: list owned account, category and merchant names with ids, tags and events. Other tools already accept names and label ids with names.", inputSchema: z.object({}).strict(), execute: () => aiEvidence(["accounts", "transactions"], latest => loadInvestigationEntities(latest)) }),
          finance_detail: tool({ description: "Read an owned canonical transaction with its effective split/fee components, or a recurring series with complete paginated source transactions. Classification warnings remain explicit.", inputSchema: investigationDetailSchema, execute: input => aiEvidence(input.kind === "recurring" ? ["accounts", "transactions", "planning"] : ["accounts", "transactions"], latest => investigationDetail(input, latest, { canReadImports: latest.settings.ai_data_scopes.includes("imports") }), false, true) }),
          finance_scenario: tool({ description: "Compare the same investigation against at most 100 hypothetical effective-record amount/date/category overrides. Read-only; canonical ledger, sources, balances and recurrence remain unchanged. Use exact minor-unit strings and owned effective IDs.", inputSchema: investigationScenarioSchema, execute: input => aiEvidence(["accounts", "transactions"], latest => evaluateInvestigationScenario(input, latest, { canReadImports: latest.settings.ai_data_scopes.includes("imports") }), false, true) }),
        } : {}),
        ...(replaceable ? { call_replace_task: tool({ description: `Only when the user explicitly drops their latest still-running request from this call ("${replaceable.text.slice(0, 80)}", requestId ${replaceable.requestId}) for this one, as in "leave that, do this" or "no, I meant last month". Otherwise both run. Stops it, or lets it finish and dismisses its cards. Call before answering this request.`,
          inputSchema: z.object({ requestId: z.uuid() }).strict(), execute: async ({ requestId: target }) => {
            if (target !== replaceable.requestId) throw new Error("Only the latest running request from this call can be replaced");
            return replaceCallTask(supabase, { workspaceId: workspace.id, conversationId, requestId: target });
          } }) } : {}),
        ...(settings.ai_data_scopes.includes("transactions") ? { agents_findings: tool({ description: "Read what the agent team found in its recent runs: open proposals (categorizations, recurring bills, budgets, anomaly findings) with ids, plus each run's briefing and page link. Set includeDecided to also see accepted and dismissed ones.",
          inputSchema: z.object({ includeDecided: z.boolean().optional() }).strict(), execute: ({ includeDecided }) => aiEvidence(["transactions"], latest => agentFindings(latest.supabase, workspace.id, { includeDecided })) }) } : {}),
        ...(settings.ai_data_scopes.includes("imports") ? { imports_status: tool({
          description: "Read recorded import workflow status and row counts. Completed means processing finished, not that all financial classifications or current balances are complete. Use this to answer whether imports are still running; do not infer status from balance freshness or filenames.",
          inputSchema: z.object({}).strict(), execute: () => aiEvidence(["imports"], async latest => {
            const { data, error } = await latest.supabase.from("imports")
              .select("id, filename, status, total_rows, new_rows, matched_rows, review_rows, classification_review_rows, rejected_rows, error")
              .eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(30);
            if (error) throw error;
            return { imports: data ?? [] };
          }),
        }) } : {}),
        ...(settings.ai_data_scopes.includes("transactions") ? { transactions_previewCategory: tool({ description: "Read-only impact preview for exact selected transaction UUIDs and an existing category UUID. Returns a link where the user reviews current entries and explicitly confirms an audited bulk change. Never changes any transaction.", inputSchema: categoryPreviewSchema, execute: ({ transactionIds, categoryId }) => aiEvidence(["transactions"], latest =>
          loadCategoryPreview(latest.supabase, workspace.id, transactionIds, categoryId)) }) } : {}),
        ...(canInvestigate ? { reviews_investigate: tool({ description: "Investigate the selected query or an explicitly dated default review, with exact spending changes, account evidence, classification limitations and permitted planning evidence. Read-only.", inputSchema: z.object({ query: investigationSchema.optional() }).strict(), execute: ({ query } = {}) => aiEvidence(["accounts", "transactions"], latest =>
          loadFinancialReviewEvidence(latest.supabase, latest.workspace, latest.settings, query), true, true) }) } : {}),
        ...(canInvestigate ? { reviews_start: tool({ description: "Investigate the current user's finance question through a bounded, durable, cancelable review. Preserve their chosen dates, entities and focus in query/focus; the application binds the exact question and visible navigation context. Use ordinary finance queries for quick answers, and this tool when follow-up evidence gathering or a saved report is useful. Do not start when the user declines investigation or only asks what a review does. Repeated calls reuse one job; no canonical financial changes.", inputSchema: reviewRequestSchema.omit({question: true, version: true, context: true, allowedScopes: true}), execute: (input = {includePlanning: false, output: "answer", budget: {maxQueries: 6, maxSupportRecords: 60, maxOutputTokens: 4000, maxDurationMs: 90000}}) => aiEvidence(["accounts", "transactions"], async latest => {
          if (stop.signal.aborted) throw new Error("Request canceled");
          if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL) throw new Error("Financial review service is not configured");
          const specification = resolveReviewRequest({...input, version: 1, question: message, context: capturedContext, allowedScopes: settings.ai_data_scopes}, calendarDate(new Date(), settings.timezone));
          if (specification.includePlanning) requireAiScope(latest.settings, "planning");
          return { ...await startFinancialReview(latest.supabase, workspace.id, requestId, requestId, specification), href: "/ai" };
        }) }) } : {}),
        ...(settings.ai_data_scopes.includes("accounts") ? { accounts_list: tool({ description: "List the user's accounts", inputSchema: z.object({}), execute: () => aiEvidence(["accounts"], latest => listAccounts(latest)) }),
        accounts_getBalances: tool({ description: "Get dated balances, provenance and source coverage", inputSchema: z.object({}), execute: () => aiEvidence(["accounts"], latest => getBalances(latest, latest.settings.ai_data_scopes.includes("imports")), false, true) }) } : {}),
        ...(settings.ai_data_scopes.includes("transactions") ? { analytics_cashflow: tool({ description: "Exact accepted posted income/spending with source coverage. Choose view base for direct exact posting-date FX and per-canonical-posting half-away rounding, or original for separate currency subtotals. Omitted view preserves single-currency accounting. Conversion completeness does not prove statement completeness; partial totals are not bounds. Missing rates return incomplete evidence, never guessed money.", inputSchema: financeToolSchemas.periodInput, execute: input => aiEvidence(["transactions"], latest => cashflow(input, latest, latest.settings.ai_data_scopes.includes("imports")), false, true) }),
        transactions_search: tool({ description: "Find transactions, newest first. Filter by description text, posted date range (from/to), absolute amount range in minor units, and limit (default 20, max 50).", inputSchema: financeToolSchemas.searchInput, execute: input => aiEvidence(["transactions"], latest => searchTransactions(input, latest)) }) } : {}),
        ...(canInvestigate ? { iou_findRepayments: tool({ description: "Check recent bank transactions for repayments of money the user lent to or borrowed from people, and show each as a card to accept or dismiss. Nothing changes until they accept.", inputSchema: z.object({}).strict(),
          execute: () => aiEvidence(["accounts", "transactions"], async latest => {
            const found = await proposeRepayments({ ...latest, chatRequestId: requestId });
            proposalCards.push(...found.map(item => item.id as string));
            return { found: found.map(item => item.title), note: found.length ? "Cards are shown to the user below your answer." : "No new repayments found." };
          }) }) } : {}),
        ...(settings.ai_data_scopes.includes("planning") && settings.ai_data_scopes.includes("transactions") ? { recurring_list: tool({ description: "List confirmed recurring payments and income (id, name, amount, direction, cadence, next date, category) and detected suggestions not yet confirmed. Use before recurring_propose to change, remove or confirm one.", inputSchema: z.object({}).strict(), execute: () => aiEvidence(["transactions", "planning"], latest => listRecurring(latest)) }) } : {}),
        ...(settings.ai_data_scopes.includes("planning") ? { goals_list: tool({ description: "List the user's goals", inputSchema: z.object({}), execute: () => aiEvidence(["planning"], latest => listGoals(latest)) }),
        wealth_list: tool({ description: "List what the Wealth page holds: money the user lent to people and owes to people (by person), plus other assets, holdings and debts, with totals per currency. Use for questions like \"how much have I lent and to whom\" or \"what do I owe\".", inputSchema: z.object({}).strict(), execute: () => aiEvidence(["planning"], latest => listWealth(latest)) }) } : {}),
        ...(settings.ai_data_scopes.includes("planning") && settings.ai_data_scopes.includes("accounts") && settings.ai_data_scopes.includes("transactions") ? { forecast_evaluate: tool({ description: "Deterministic account headroom and dated funding shortfalls with source coverage. Choose accountId for available to spend; aggregate cash requires explicit funding. Cases are assumptions, not probabilities", inputSchema: forecastInput, execute: input => aiEvidence(["accounts", "transactions", "planning"], latest => evaluateForecast(input, latest), false, true) }) } : {}),
        ...(canChangeCategory ? {
          transactions_setCategory: tool({
            description: "Change only the category of a specific transaction, only when the current user explicitly asked for this change. Search first if its ID is unknown. The correction is audited and can be undone from the returned transaction link.",
            inputSchema: z.object({ transactionId: z.uuid(), category: z.string().trim().min(1).max(100) }).strict(),
            execute: async ({ transactionId, category }) => {
              if (!categoryCommand || transactionId !== categoryCommand.transactionId || category !== categoryCommand.category)
                throw new Error("Action must match the exact transaction and category selected by the user");
              const { data, error } = await supabase.rpc("chat_set_category", {
                p_request_id: requestId, p_transaction_id: transactionId, p_category: category,
              });
              if (error) throw error;
              return data;
            },
          }),
        } : {}),
      }) },
    });
    // The answer is all text the model wrote, across steps, exactly as streamed to the user.
    let text = "", stepBreak = false;
    for await (const part of result.fullStream) {
      if (part.type === "text-delta" && part.text) {
        const delta = stepBreak && text.trim() ? `\n\n${part.text}` : part.text;
        stepBreak = false; text += delta;
        emit({ type: "delta", text: delta });
      } else if (part.type === "finish-step") stepBreak = true;
      else if (part.type === "error") throw part.error instanceof Error ? part.error : new Error("AI request failed");
    }
    const [usage, steps] = await Promise.all([result.usage, result.steps]);
    if (!text.trim()) throw new Error("The model returned no answer");
    // Several cards from one answer are grouped so they can also be added all at once.
    const cards = [...new Set(proposalCards)];
    const cardBlocks = cards.length > 1 ? ["```moneo-proposals\n" + JSON.stringify(cards) + "\n```"] : cards.map(id => "```moneo-proposal\n" + id + "\n```");
    const answer = [text.trim(), ...cardBlocks, ...new Set(decisionCards)].join("\n\n");
    const current = await requireWorkspace();
    if (current.workspace.id !== workspace.id) throw new Error("Workspace changed");
    if (stop.signal.aborted) throw new Error("Request canceled");
    requireAiScope(current.settings, ...readScopes);
    const toolsUsed = [...new Set(steps.flatMap(step => step.toolResults.flatMap(toolResult => toolResult ? [toolResult.toolName] : [])))];
    const followUps = chatFollowUps(message, toolsUsed, modelFollowUps);
    // The answer is final; show it while the durable publication below completes.
    emit({ type: "answer", conversationId, answer, toolsUsed, followUps });
    const finished = await supabase.rpc("finish_chat_request", { p_request_id: requestId, p_status: "completed", p_content: answer,
      p_usage: reportedUsage(model.modelId, usage), p_tool_calls: toolCalls });
    if (finished.error) throw finished.error;
    if (finished.data !== "completed") return [{ status: finished.data, error: `Request is ${finished.data}` }, 409];
    return [{ conversationId, answer, toolsUsed, followUps }, 200];
  } catch (error) {
    const failure = error instanceof Error ? error.message : "AI request failed";
    // Finishing changes only a running request, so a canceled one stays canceled.
    await supabase.rpc("finish_chat_request", { p_request_id: requestId, p_status: "failed", p_content: failure.slice(0, 500) });
    // A stopped request was canceled, not failed: say so, so a call shows it as stopped.
    return stop.signal.aborted ? [{ status: "canceled", error: "Request is canceled" }, 409] : [{ error: failure }, 502];
  }
  }
  if (!streaming) { const run = complete(() => {}); after(() => run); const [body, status] = await run; return Response.json(body, { status }); }
  // Opt-in NDJSON: tool progress and the verified answer arrive before publication finishes.
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) {
    const write = (event: ChatStreamEvent) => { try { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); } catch { /* the reader went away; work continues */ } };
    write({ type: "started" });
    // after() keeps the run alive once the reader goes away (tab closed, phone locked).
    const run = complete(write);
    after(() => run);
    void run.then(([body, status]) => { write({ type: "result", status, body }); try { controller.close(); } catch { /* already closed */ } });
  } }), { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}


export async function PATCH(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const parsed = z.object({ requestId: z.uuid() }).strict().safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid cancellation" }, { status: 400 });
  const result = await context.supabase.rpc("cancel_chat_request", { p_request_id: parsed.data.requestId });
  if (result.error) return Response.json({ error: result.error.message }, { status: result.error.code === "P0002" ? 404 : 400 });
  return Response.json({ status: result.data });
}


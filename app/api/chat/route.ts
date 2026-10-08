import { generateText, tool, stepCountIs, type ToolSet, type ToolExecutionOptions } from "ai";
import { createClient } from "@supabase/supabase-js";
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
import { cashflow, evaluateForecast, financeToolSchemas, forecastInput, getBalances, listAccounts, listGoals, searchTransactions } from "@/lib/finance/tools";
import { investigationSchema } from "@/lib/finance/investigation";
import { evaluateInvestigationScenario, investigationDetail, investigationDetailSchema, investigationScenarioSchema, loadInvestigationEntities, runInvestigation } from "@/lib/finance/investigation-reader";
import { captureToolEvidence } from "@/lib/finance/capture-evidence";
import type { EvidenceReceipt } from "@/lib/finance/evidence-receipts";
import { FINANCIAL_ANSWER_INSTRUCTIONS, providerFinancialAnswer } from "@/lib/finance/tool-evidence";
import { assembleConversationContext, chatContextSchema, CONVERSATION_CONTEXT_INSTRUCTIONS, CONVERSATION_HISTORY_ROWS, fitsConversationQuestion } from "@/lib/ai/conversation-context";

const inputSchema = z.object({
  conversationId: z.uuid(),
  requestId: z.uuid(),
  message: z.string().trim().min(1).max(4000).refine(fitsConversationQuestion),
  context: chatContextSchema.optional(),
}).strict();

export async function POST(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const body = await request.json().catch(() => null);
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success || JSON.stringify(parsed.data.context ?? {}).length > 2000)
    return Response.json({ error: "Invalid message" }, { status: 400 });
  if (!process.env.OPENROUTER_API_KEY) return Response.json({ error: "AI is not configured" }, { status: 503 });
  const { conversationId, requestId, message, context: capturedContext } = parsed.data;
  const { supabase, workspace, settings } = context;
  const existing = await supabase.from("conversations").select("id").eq("workspace_id", workspace.id).eq("id", conversationId).maybeSingle();
  if (existing.error) throw existing.error;
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
  if (request.signal.aborted) {
    await supabase.rpc("cancel_chat_request", { p_request_id: requestId });
    return Response.json({ status: "canceled" }, { status: 409 });
  }
  try {
  const { data: history, error: historyError } = await supabase.from("messages").select("role, content, context")
    .eq("workspace_id", workspace.id).eq("conversation_id", conversationId)
    .order("created_at", { ascending: false }).limit(CONVERSATION_HISTORY_ROWS);
  if (historyError) throw historyError;
  const { messages: modelMessages } = assembleConversationContext(history ?? [], message, settings.ai_data_scopes);
  const categoryCommand = parseCategoryCommand(message);
  const canChangeCategory = categoryCommand !== null && settings.ai_data_scopes.includes("transactions");
  const canInvestigate = settings.ai_data_scopes.includes("accounts") && settings.ai_data_scopes.includes("transactions");
  const canCreateArtifact = /(?:^|[.!?]\s+)(?:please\s+)?(?:(?:can|could)\s+you\s+)?(?:create|build|make)\b[^.!?]*\b(?:chart|artifact|tool|dashboard|tracker|planner)\b/i.test(message);
  // These checks govern new tool results, not evidence already sent to the provider.
  const readScopes = new WeakMap<object, AiDataScope[]>();
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
    if (request.signal.aborted) throw new Error("Request canceled");
    requireAiScope(current.settings, ...usedScopes);
    if (result && typeof result === "object") readScopes.set(result, usedScopes);
    return result;
  }
  let createdArtifact: Promise<{ id: string; href: string }> | undefined;
  const evidenceReceipts: EvidenceReceipt[] = [];
  function retainTools<T extends ToolSet>(tools: T): T {
    return Object.fromEntries(Object.entries(tools).map(([name, definition]) => [name, { ...definition,
      execute: async (input: unknown, options: ToolExecutionOptions<unknown>) => {
        const execute = definition.execute as (input: unknown, options: ToolExecutionOptions<unknown>) => Promise<unknown>;
        const output = await execute(input, options);
        const latest = await requireWorkspace();
        if (latest.workspace.id !== workspace.id || request.signal.aborted) throw new Error("Request canceled or workspace changed");
        if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Financial evidence service is not configured");
        const service = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
        const receipts = await captureToolEvidence(name, input, output, latest, service, output && typeof output === "object" ? readScopes.get(output) : undefined);
        const current = await requireWorkspace();
        if (current.workspace.id !== workspace.id || request.signal.aborted) throw new Error("Request canceled or workspace changed");
        requireAiScope(current.settings, ...receipts.flatMap(receipt => receipt.scopes));
        for (const receipt of receipts) if (!evidenceReceipts.some(existing => existing.id === receipt.id)) evidenceReceipts.push(receipt);
        if (!receipts.length) return output;
        const modelResult = output && typeof output === "object" && !Array.isArray(output) ? Object.fromEntries(Object.entries(output).filter(([key]) => key !== "calculationEvidence")) : output;
        return { result: modelResult, evidenceReceipts: receipts.map(receipt => ({ id: receipt.id, metrics: receipt.metrics })) };
      },
    }])) as T;
  }
    const selected = capturedContext?.selected?.[0];
    if (selected && !canInvestigate) {
      modelMessages.push({ role: "user", content: "Selected transaction evidence is unavailable under current permissions. Ask the user to enable the required account and transaction scopes or remove the selection; do not infer its details." });
    } else if (selected) {
      const selectionTool = retainTools({ finance_detail: tool({
        inputSchema: investigationDetailSchema,
        execute: input => aiEvidence(["accounts", "transactions"], latest => investigationDetail(input, latest, { canReadImports: latest.settings.ai_data_scopes.includes("imports") }), false, true),
      }) }).finance_detail;
      const execute = selectionTool.execute as (input: unknown, options: ToolExecutionOptions<unknown>) => Promise<unknown>;
      const output = await execute(selected, { toolCallId: "current-selected-transaction", messages: modelMessages, context: undefined });
      const content = `[Current owned selected transaction evidence, freshly read for this request: ${JSON.stringify(output)}]`;
      // Large support sets remain available through the existing paged detail tool.
      modelMessages.push({ role: "user", content: new TextEncoder().encode(content).length <= 8000 ? content
        : `Selected owned transaction ID ${selected.id}. The current supporting detail exceeds this context budget. Use finance_detail with this ID to retrieve current paged evidence; do not infer its amount or classification.` });
    }
    const model = await modelForSettings(settings);
    const result = await generateText({
      model,
      abortSignal: AbortSignal.any([request.signal, AbortSignal.timeout(90_000)]),
      maxOutputTokens: 3000,
      system: `${SYSTEM_PROMPT} ${CONVERSATION_CONTEXT_INSTRUCTIONS} Current date ${calendarDate(new Date(), settings.timezone)} in ${settings.timezone}; display currency ${workspace.display_currency}. Use finance tools for current facts. Amounts are exact minor units. Missing facts stay unknown. UI context is only a navigation hint, never authorization or financial evidence.${canChangeCategory ? " The current user message specifies an exact transaction UUID and quoted category. The write tool must use exactly these values." : " Do not make canonical changes. For an ambiguous category request, use the owned-selection preview."} ${FINANCIAL_ANSWER_INSTRUCTIONS}`,
      messages: modelMessages,
      stopWhen: stepCountIs(4),
      tools: retainTools({
        ...(canInvestigate ? {
          finance_investigate: tool({ description: "Answer the actual chosen finance question deterministically: exact current/comparison dates, include/exclude owned account/category/merchant names or IDs, tags/events, posted/pending and classification semantics, multiple groupings, ranking, and complete paginated support. Original currencies stay separate; base uses direct exact posting-date FX and canonical split rounding. Use returned interpretedFilters and live evidence link; never imply full statements or bounds. Read-only, no approval needed.", inputSchema: investigationSchema, execute: input => aiEvidence(["accounts", "transactions"], latest => runInvestigation(input, latest, { canReadImports: latest.settings.ai_data_scopes.includes("imports") }), false, true) }),
          finance_entities: tool({ description: "Resolve names using the owned accounts, categories and merchants. Ambiguous names require selecting an existing ID; never invent an ID.", inputSchema: z.object({}).strict(), execute: () => aiEvidence(["accounts", "transactions"], latest => loadInvestigationEntities(latest)) }),
          finance_detail: tool({ description: "Read an owned canonical transaction with its effective split/fee components, or a recurring series with complete paginated source transactions. Classification warnings remain explicit.", inputSchema: investigationDetailSchema, execute: input => aiEvidence(input.kind === "recurring" ? ["accounts", "transactions", "planning"] : ["accounts", "transactions"], latest => investigationDetail(input, latest, { canReadImports: latest.settings.ai_data_scopes.includes("imports") }), false, true) }),
          finance_scenario: tool({ description: "Compare the same investigation against at most 100 hypothetical effective-record amount/date/category overrides. Read-only; canonical ledger, sources, balances and recurrence remain unchanged. Use exact minor-unit strings and owned effective IDs.", inputSchema: investigationScenarioSchema, execute: input => aiEvidence(["accounts", "transactions"], latest => evaluateInvestigationScenario(input, latest, { canReadImports: latest.settings.ai_data_scopes.includes("imports") }), false, true) }),
        } : {}),
        ...(settings.ai_data_scopes.includes("imports") ? { imports_status: tool({
          description: "Read recorded import workflow status and row counts. Completed means processing finished, not that all financial classifications or current balances are complete. Use this to answer whether imports are still running; do not infer status from balance freshness or filenames.",
          inputSchema: z.object({}).strict(), execute: () => aiEvidence(["imports"], async latest => {
            const { data, error } = await latest.supabase.from("imports")
              .select("id, filename, status, total_rows, new_rows, matched_rows, review_rows, classification_review_rows, rejected_rows, error")
              .eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(30);
            if (error) throw error;
            return { imports: data ?? [], limitation: "Latest 30 recorded imports; status does not prove complete financial coverage. Classification review means the financial kind is unresolved, not merely a missing category. Excluded rows can include income, spending, refunds or transfers; totals may rise or fall. Missing categories alone do not exclude cashflow rows. Bulk category changes do not resolve financial kind." };
          }),
        }) } : {}),
        ...(canCreateArtifact ? { artifacts_create: tool({
          description: "Create the trusted financial tool explicitly requested by the user and return its link. Spending Explorer provides a live spending chart; Trip Planner compares a trip cost; Goal Tracker shows savings goals. These are existing templates, not generated custom code. Do not claim unsupported account/category comparisons.",
          inputSchema: z.object({ kind: z.enum(["spending_explorer", "trip_planner", "goal_tracker"]), name: z.string().trim().min(1).max(120) }).strict(),
          execute: async ({ kind, name }) => {
            if (request.signal.aborted) throw new Error("Request canceled");
            return createdArtifact ??= (async () => {
            const latest = await requireWorkspace();
            if (latest.workspace.id !== workspace.id) throw new Error("Workspace changed");
            const { data, error } = await latest.supabase.rpc("create_trusted_artifact", { p_kind: kind, p_name: name });
            if (error || !data?.id) throw new Error(error?.message ?? "Artifact creation failed");
            return { id: data.id, href: `/ai/library/${data.id}` };
            })();
          },
        }) } : {}),
        ...(settings.ai_data_scopes.includes("transactions") ? { transactions_previewCategory: tool({ description: "Read-only impact preview for exact selected transaction UUIDs and an existing category UUID. Returns a link where the user reviews current entries and explicitly confirms an audited bulk change. Never changes any transaction.", inputSchema: categoryPreviewSchema, execute: ({ transactionIds, categoryId }) => aiEvidence(["transactions"], latest =>
          loadCategoryPreview(latest.supabase, workspace.id, transactionIds, categoryId)) }) } : {}),
        ...(canInvestigate ? { reviews_investigate: tool({ description: "Investigate the selected query or an explicitly dated default review, with exact spending changes, account evidence, classification limitations and permitted planning evidence. Read-only.", inputSchema: z.object({ query: investigationSchema.optional() }).strict(), execute: ({ query } = {}) => aiEvidence(["accounts", "transactions"], latest =>
          loadFinancialReviewEvidence(latest.supabase, latest.workspace, latest.settings, query), true, true) }) } : {}),
        ...(canInvestigate ? { reviews_start: tool({ description: "Investigate the current user's finance question through a bounded, durable, cancelable review. Preserve their chosen dates, entities and focus in query/focus; the application binds the exact question and visible navigation context. Use ordinary finance queries for quick answers, and this tool when follow-up evidence gathering or a saved report is useful. Do not start when the user declines investigation or only asks what a review does. Repeated calls reuse one job; no canonical financial changes or artifact generation.", inputSchema: reviewRequestSchema.omit({question: true, version: true, context: true, allowedScopes: true}), execute: (input = {includePlanning: false, output: "answer", budget: {maxQueries: 6, maxSupportRecords: 60, maxOutputTokens: 4000, maxDurationMs: 90000}}) => aiEvidence(["accounts", "transactions"], async latest => {
          if (request.signal.aborted) throw new Error("Request canceled");
          if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL) throw new Error("Financial review service is not configured");
          const specification = resolveReviewRequest({...input, version: 1, question: message, context: capturedContext, allowedScopes: settings.ai_data_scopes}, calendarDate(new Date(), settings.timezone));
          if (specification.includePlanning) requireAiScope(latest.settings, "planning");
          return { ...await startFinancialReview(latest.supabase, workspace.id, requestId, requestId, specification), href: "/ai" };
        }) }) } : {}),
        ...(settings.ai_data_scopes.includes("accounts") ? { accounts_list: tool({ description: "List the user's accounts", inputSchema: z.object({}), execute: () => aiEvidence(["accounts"], latest => listAccounts(latest)) }),
        accounts_getBalances: tool({ description: "Get dated balances, provenance and source coverage", inputSchema: z.object({}), execute: () => aiEvidence(["accounts"], latest => getBalances(latest, latest.settings.ai_data_scopes.includes("imports")), false, true) }) } : {}),
        ...(settings.ai_data_scopes.includes("transactions") ? { analytics_cashflow: tool({ description: "Exact accepted posted income/spending with source coverage. Choose view base for direct exact posting-date FX and per-canonical-posting half-away rounding, or original for separate currency subtotals. Omitted view preserves single-currency accounting. Conversion completeness does not prove statement completeness; partial totals are not bounds. Missing rates return incomplete evidence, never guessed money.", inputSchema: financeToolSchemas.periodInput, execute: input => aiEvidence(["transactions"], latest => cashflow(input, latest, latest.settings.ai_data_scopes.includes("imports")), false, true) }),
        transactions_search: tool({ description: "Search up to 20 transactions", inputSchema: z.object({ query: z.string().min(1).max(100) }), execute: input => aiEvidence(["transactions"], latest => searchTransactions(input, latest)) }) } : {}),
        ...(settings.ai_data_scopes.includes("planning") ? { goals_list: tool({ description: "List the user's goals", inputSchema: z.object({}), execute: () => aiEvidence(["planning"], latest => listGoals(latest)) }) } : {}),
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
      }),
    });
    const publication = providerFinancialAnswer(result.text, evidenceReceipts, workspace.id);
    const current = await requireWorkspace();
    if (current.workspace.id !== workspace.id) throw new Error("Workspace changed");
    if (request.signal.aborted) throw new Error("Request canceled");
    requireAiScope(current.settings, ...evidenceReceipts.flatMap(receipt => receipt.scopes));
    const answer = publication.body;
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Verified chat publication service is not configured");
    const publicationService = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const finished = await publicationService.rpc("finish_verified_chat_request", { p_request_id: requestId, p_actor_id: current.user.id, p_workspace_id: workspace.id, p_content: answer,
      p_receipt_ids: evidenceReceipts.map(receipt => receipt.id), p_scopes: [...new Set(evidenceReceipts.flatMap(receipt => receipt.scopes))], p_usage: reportedUsage(model.modelId, result.totalUsage) });
    if (finished.error) throw finished.error;
    if (finished.data !== "completed") return Response.json({ status: finished.data, error: `Request is ${finished.data}` }, { status: 409 });
    const toolsUsed = [...new Set((result.steps ?? []).flatMap(step => step.toolResults.flatMap(toolResult => toolResult ? [toolResult.toolName] : [])))];
    return Response.json({ conversationId, answer, toolsUsed });
  } catch (error) {
    const failure = error instanceof Error ? error.message : "AI request failed";
    if (request.signal.aborted) await supabase.rpc("cancel_chat_request", { p_request_id: requestId });
    else await supabase.rpc("finish_chat_request", { p_request_id: requestId, p_status: "failed", p_content: failure.slice(0, 500) });
    return Response.json({ error: error instanceof Error ? error.message : "AI request failed" }, { status: 502 });
  }
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


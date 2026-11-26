import { streamText, tool, stepCountIs, type ToolSet, type ToolExecutionOptions } from "ai";
import { after } from "next/server";
import { z } from "zod";
import { getModel, modelForSettings, SYSTEM_PROMPT, withTools } from "@/lib/ai/provider";
import { CHAT_MAX_STEPS, moneoToolName } from "@/lib/ai/claude";
import { DataQueryError, dataQueryChartDataset, dataQueryDescription, dataQueryInput, dataQueryOutput, runDataQuery } from "@/lib/ai/data-query";
import { aiConfigured } from "@/lib/ai/configured";
import { requireWorkspace, type ReadonlyWorkspace } from "@/lib/auth";
import { requireAiScope, type AiDataScope } from "@/lib/settings";
import { calendarDate } from "@/lib/finance/calendar";
import { reportedUsage } from "@/lib/ai/usage";
import { parseCategoryCommand } from "@/lib/ai/write-intent";
import {reviewRequestSchema, resolveReviewRequest} from "@/lib/finance/review-request";
import { categoryPreviewSchema, loadCategoryPreview } from "@/lib/finance/edit-preview";
import { cashflow, evaluateForecast, financeToolSchemas, forecastInput, getBalances, listAccounts, listGoals, listWealth, searchTransactions } from "@/lib/finance/tools";
import { netWorthInput, readNetWorth } from "@/lib/finance/net-worth-source";
import { investigationSchema } from "@/lib/finance/investigation";
import { evaluateInvestigationScenario, investigationDetail, investigationDetailSchema, investigationScenarioSchema, loadInvestigationEntities, runInvestigation } from "@/lib/finance/investigation-reader";
import type { ChatStreamEvent } from "@/lib/ai/use-chat-request";
import { branchHistory, chatSkeleton } from "@/lib/ai/branch-history";
import { ancestors } from "@/lib/ai/chat-tree";
import { chatFollowUps, planInput } from "@/lib/ai/follow-ups";
import { iouInputSchema, proposeIou, proposeRepayments } from "@/lib/ai/iou-proposals";
import { proposeTransaction, transactionInputSchema } from "@/lib/ai/transaction-proposals";
import { balanceInputSchema, proposeBalance } from "@/lib/ai/balance-proposals";
import { listRecurring, proposeRecurring, recurringInputSchema } from "@/lib/ai/recurring-proposals";
import { organizeInputSchema, organizeReview, organizeReviewSchema, proposeOrganizeAnswer } from "@/lib/ai/organize-proposals";
import { APP_GUIDE } from "@/lib/ai/app-guide";
import { MAX_ATTACHMENTS, attachmentId, isImage } from "@/lib/ai/chat-attachments";
import { attachmentNote, attachmentSchema } from "@/lib/ai/chat-attachment-schema";
import { readDocument } from "@/lib/ai/documents/read";
import { conversationAttachments, documentText, findAttachment } from "@/lib/ai/documents/store";
import { answerCardIds } from "@/lib/ai/open-proposals";
import { agentDecisionSchema, agentFindings, decisionBlock, openAgentProposalIds } from "@/lib/ai/agent-findings";
import { readableToolOutput, toolOutputPreview, type EntityNames } from "@/lib/ai/tool-output";
import { ADDS_TO_RUNNING, CALL_MODE_PROMPT, callContextSchema, replaceCallTask, withoutCallBrief } from "@/lib/ai/voice-call";
import { activeScalableConnection, READ_ONLY_TRADING } from "@/lib/scalable/live";
import { titleChatTurn } from "@/lib/ai/chat-title";
import { VOICE_CALL_TITLE } from "@/lib/ai/voice-access";
import { ownerBrief } from "@/lib/ai/owner-brief";
import { awaitedLater } from "@/lib/awaited-later";
import { jsonObject } from "@/lib/database";
import { chartDatasets, resolveChartBlocks } from "@/lib/ai/chart-spec";
import { chartDataInput, chartDataScopes, describeDataset, loadChartData } from "@/lib/ai/chart-data";
import { serviceRoleConfig } from "@/lib/env";
import { jsonBodyOrNull } from "@/lib/json-body";
import { modelIdSchema } from "@/lib/ai/model-id";

function withoutCharts(content: string) {
  return content.replace(/```moneo-chart\n[\s\S]*?```/g, "[chart]").replace(/```moneo-(?:proposals?|decision)\n[\s\S]*?```/g, "[card shown]");
}

export const maxDuration = 300;
const TITLE_WAIT_MS = 2000;
const streamEndsWhenTheClientLeaves = () => undefined;

const inputSchema = z.object({
  conversationId: z.uuid(),
  requestId: z.uuid(),
  message: z.string().trim().min(1).max(4000),
  regenerates: z.uuid().optional(),
  parent: z.uuid().optional(),
  edits: z.uuid().optional(),
  model: modelIdSchema.optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS).optional(),
}).strict();

const chatKeepsItsTitleWhenNamingFails = () => null;
const cancelIsCheckedAgainOnTheNextStep = () => null;

export async function POST(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const body = await jsonBodyOrNull(request);
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success || JSON.stringify(parsed.data.context ?? {}).length > (parsed.data.context?.via === "call" ? 8000 : 2000))
    return Response.json({ error: "Invalid message" }, { status: 400 });
  const { conversationId, requestId, message, regenerates, parent, edits, model: requestedModel, context: capturedContext, attachments = [] } = parsed.data;
  const { supabase, workspace, settings } = context;
  const existingPromise = awaitedLater(Promise.resolve(supabase.from("conversations").select("id, deleted_at, artifact_id, title_settled, model").eq("workspace_id", workspace.id).eq("id", conversationId).maybeSingle()));
  if (!(await aiConfigured())) return Response.json({ error: "No AI is set up yet. Sign in with ChatGPT or Claude, or add an API key under Settings → AI access." }, { status: 503 });
  if (attachments.some(file => !file.path.startsWith(`${workspace.id}/`))) return Response.json({ error: "Invalid attachment" }, { status: 400 });
  const viaCall = capturedContext?.via === "call";
  const skeletonPromise = awaitedLater(chatSkeleton(supabase, workspace.id, conversationId));
  const existing = await existingPromise;
  if (existing.error) throw existing.error;
  if (existing.data?.deleted_at) return Response.json({ error: "Conversation was deleted" }, { status: 404 });
  const chosenModel = viaCall ? undefined : requestedModel ?? existing.data?.model ?? undefined;
  const artifactId = existing.data?.artifact_id ?? null;
  const modelPromise = awaitedLater(chosenModel ? getModel(chosenModel) : modelForSettings(settings, viaCall ? "voice_call" : artifactId ? "artifacts" : "chat"));
  const scalablePromise = settings.ai_data_scopes.includes("accounts") ? awaitedLater(activeScalableConnection(workspace.id)) : Promise.resolve(null);
  const briefPromise = ownerBrief(context).catch(error => { console.error("owner brief failed", error); return null; });
  const artifactModules = artifactId ? awaitedLater(Promise.all([import("@/lib/ai/artifact-agent"), import("@/lib/ai/artifact-preview")])) : null;
  if (!existing.data) {
    const { error } = await supabase.from("conversations").insert({ id: conversationId, workspace_id: workspace.id, title: viaCall ? VOICE_CALL_TITLE : message.slice(0, 80), ...(requestedModel && !viaCall && { model: requestedModel }) });
    if (error && error.code !== "23505") return Response.json({ error: "Conversation unavailable" }, { status: 403 });
  }
  const claim = await supabase.rpc("start_chat_request", {
    p_request_id: requestId, p_conversation_id: conversationId, p_message: message, p_context: capturedContext ?? {}, ...(regenerates && { p_regenerates: regenerates }), ...(parent && { p_parent: parent }), ...(edits && { p_edits: edits }),
  });
  if (claim.error) return Response.json({ error: claim.error.message }, { status: 400 });
  if (!claim.data.started) {
    if (claim.data.status === "completed") return Response.json({ conversationId, answer: claim.data.answer, parent: claim.data.parent ?? null });
    return Response.json({ error: `Request is ${claim.data.status}`, status: claim.data.status }, { status: 409 });
  }
  const claimedParent = claim.data.parent ?? null;
  const artifactPromise = artifactId && artifactModules ? awaitedLater(Promise.all([artifactModules, skeletonPromise]).then(async ([[agent, preview], nodes]) => {
    const branch = new Set([...ancestors(nodes, claimedParent).map(node => node.id), requestId]);
    return { agent, branch, briefing: await agent.artifactBriefing(supabase, workspace.id, artifactId, branch), session: preview.sessionOf(request) };
  })) : null;
  const historyPromise = awaitedLater(skeletonPromise.then(nodes => branchHistory(supabase, workspace.id, conversationId, nodes, claimedParent)));
  if (attachments.length && !regenerates) {
    const saved = await supabase.from("messages").update({ attachments }).eq("workspace_id", workspace.id).eq("conversation_id", conversationId)
      .eq("request_id", requestId).eq("role", "user");
    if (saved.error) console.error("saving chat attachments failed", saved.error);
  }
  let conversationFiles: ReturnType<typeof conversationAttachments> | undefined;
  async function writeChatTitle() {
    if (artifactId) return null;
    const earlier = viaCall ? (callContextSchema.safeParse(capturedContext).data?.recentTurns ?? []).filter(turn => turn.role === "user" && turn.text !== message).map(turn => turn.text)
      : (await historyPromise).filter(item => item.role === "user").map(item => item.content);
    return titleChatTurn({ supabase, workspaceId: workspace.id, conversationId, message, viaCall, settled: !!existing.data?.title_settled, earlier, model: () => modelForSettings(settings, "titles") });
  }
  const { promise: answerStarted, resolve: startTitle } = Promise.withResolvers<void>();
  const chatTitle = answerStarted.then(writeChatTitle).catch(chatKeepsItsTitleWhenNamingFails);
  const streaming = request.headers.get("accept")?.includes("application/x-ndjson") ?? false;
  const stop = new AbortController();
  async function stopIfCanceled() {
    const saved = await Promise.resolve(supabase.from("chat_requests").select("status").eq("workspace_id", workspace.id).eq("id", requestId).maybeSingle()).catch(cancelIsCheckedAgainOnTheNextStep);
    if (saved?.data?.status === "canceled") stop.abort();
  }
  async function complete(emit: (event: ChatStreamEvent) => void): Promise<[unknown, number]> {
  try {
  const history = await historyPromise;
  const call = callContextSchema.safeParse(capturedContext);
  const runningTasks = call.success ? (call.data.runningTasks ?? []).filter(task => task.requestId !== requestId) : [];
  const running = new Set(runningTasks.map(task => task.requestId));
  const lastAnswered = call.success ? call.data.answered?.at(-1) : undefined;
  const replaceable = ADDS_TO_RUNNING.test(message) ? undefined
    : runningTasks.at(-1) ?? (lastAnswered?.requestId && lastAnswered.requestId !== requestId ? { requestId: lastAnswered.requestId, text: lastAnswered.text } : undefined);
  const submitted = { role: "user", content: message, context: capturedContext ?? {}, attachments: [] };
  const replayed = history.filter(item => !running.has(item.request_id ?? "")).map(item => {
    const context = jsonObject.safeParse(item.context);
    return context.success && context.data.via === "call" ? { ...item, context: withoutCallBrief(context.data) } : item;
  });
  const textMessages = [...replayed, submitted].map(item => ({
    role: item.role as "user" | "assistant",
    content: item.role === "assistant" ? withoutCharts(item.content)
      : (item.context && Object.keys(item.context).length ? `${item.content}\n[UI context at submission: ${JSON.stringify(item.context)}]` : item.content) + attachmentNote(item.attachments),
  }));
  const files = attachments.length ? await (await import("@/lib/ai/documents/message")).attachmentParts(supabase, attachments) : [];
  const last = textMessages.pop()!;
  const modelMessages = [...textMessages, files.length ? { role: "user" as const, content: [{ type: "text" as const, text: last.content }, ...files] } : last];
  const categoryCommand = parseCategoryCommand(message);
  const canChangeCategory = categoryCommand !== null && settings.ai_data_scopes.includes("transactions");
  const canInvestigate = settings.ai_data_scopes.includes("accounts") && settings.ai_data_scopes.includes("transactions");
  const readScopes = new Set<AiDataScope>();
  async function scopedTool<T>(scopes: AiDataScope[], run: (latest: typeof context) => Promise<T>, includePlanning = false, includeImports = false): Promise<T> {
    const latest = await requireWorkspace();
    if (latest.workspace.id !== workspace.id) throw new Error("Workspace changed");
    requireAiScope(latest.settings, ...scopes);
    const usedScopes = [...scopes,
      ...(includePlanning && latest.settings.ai_data_scopes.includes("planning") ? ["planning" as const] : []),
      ...(includeImports && latest.settings.ai_data_scopes.includes("imports") ? ["imports" as const] : [])];
    const result = await run(latest);
    const current = await requireWorkspace();
    if (current.workspace.id !== workspace.id) throw new Error("Workspace changed");
    if (stop.signal.aborted) throw new Error("Request canceled");
    requireAiScope(current.settings, ...usedScopes);
    for (const scope of usedScopes) readScopes.add(scope);
    return result;
  }
  function aiEvidence<T>(scopes: AiDataScope[], read: (latest: ReadonlyWorkspace) => Promise<T>, includePlanning = false, includeImports = false): Promise<T> {
    return scopedTool(scopes, read, includePlanning, includeImports);
  }
  let entityNames: Promise<EntityNames> | undefined;
  function namesFor(latest: ReadonlyWorkspace): Promise<EntityNames> {
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
        if (stop.signal.aborted) throw new Error("Request canceled");
        emit({ type: "tool", id: options?.toolCallId, name, state: "running", input });
        startTitle();
        const names = namesFor(context).catch((): EntityNames => ({}));
        let output: unknown;
        try { output = await execute(input, options); }
        catch (cause) { emit({ type: "tool", id: options?.toolCallId, name, state: "failed" }); throw cause; }
        const [latest, { account, ...labels }] = await Promise.all([requireWorkspace(), names]);
        if (latest.workspace.id !== workspace.id || stop.signal.aborted) throw new Error("Request canceled or workspace changed");
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
    let modelFollowUps: string[] = [];
    const proposalCards: string[] = [];
    const earlierCards = history.flatMap(item => item.role === "assistant" ? answerCardIds(item.content) : []);
    const decisionCards: string[] = [];
    const planTool = { plan_investigation: tool({ description: "Optional: show the user 2-5 short steps you will take for a multi-part question, and up to 3 follow-up questions they might ask next. Returns nothing.",
      inputSchema: planInput, execute: async input => { emit({ type: "plan", steps: input.steps }); toolCalls.push({ name: "plan_investigation", input, output: "" }); modelFollowUps = input.followUps ?? []; return { shown: true }; } }),
      iou_propose: tool({ description: "The user says they lent or gave money to a person, or borrowed or received money from one. Shows them a card to accept or dismiss; nothing is saved until they accept. First look for the transfer with transactions_search (by name, then by amount and dates): if one fits, tell them which (date, account, name on it) and propose with its date and amount; if several fit, ask which; if none, propose with their figures and say no matching transfer was found. Check wealth_list too: a loan for the same person, amount and currency dated around the same day is already recorded, so say so instead of proposing it. Another loan to the same person is a new one; mention what they already owe. For whether someone paid them back, use iou_findRepayments.",
        inputSchema: iouInputSchema, execute: async input => {
          const created = await proposeIou({ ...await requireWorkspace(), chatRequestId: requestId }, input, [...earlierCards, ...proposalCards]);
          proposalCards.push(created.proposalId);
          return { proposed: created.title, note: `A card with Add and Dismiss is shown to the user below your answer.${created.replaced ? " It replaces the earlier card for this loan, which was dismissed." : ""} Say it is waiting for their approval; do not repeat the details.` };
        } }),
      transaction_propose: tool({ description: "The user says they spent, paid, bought, earned or received money (or an attached receipt or invoice shows it). Shows a card to add it to their transactions; nothing is saved until they accept. Call once per separate payment, not per line item, with the exact amount, currency and date from the user or document (default to the display currency and today). For an attachment, read the merchant, total, currency and date printed on it, tell the user what you read and what you couldn't, and never guess an unreadable amount.",
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
      organize_propose: tool({ description: "The user says what their payments to a payee are (a category and/or merchant that already exist). Get the payee's identityId from organize_review first. Shows a card; nothing is labelled until they accept, and then all that payee's blank or AI-labelled rows get it and future payments follow.",
        inputSchema: organizeInputSchema, execute: async input => {
          const created = await proposeOrganizeAnswer({ ...await requireWorkspace(), chatRequestId: requestId }, input);
          proposalCards.push(created.proposalId);
          return { proposed: created.title, note: "A card with Label rows and Dismiss is shown below your answer. Say it is waiting for their approval; do not repeat the details." };
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
      ...(artifactId ? {} : { suggest_artifact: tool({ description: "When the user asks for an interactive page, calculator, simulator, dashboard or what-if view, call this with a clear build request and give them the returned link. Do not build pages in chat.",
        inputSchema: z.object({ prompt: z.string().trim().min(1).max(1500) }).strict(), execute: async ({ prompt }) => ({ href: `/ai/artifacts?prompt=${encodeURIComponent(prompt)}` }) }) }) };
    const charts = chartDatasets();
    const tradeCards: string[] = [];
    const scalableConnection = await scalablePromise;
    const priorUserText = history.filter(item => item.role === "user").slice(-2).reverse().map(item => item.content);
    const scalableTools = scalableConnection ? (await import("@/lib/ai/investment-tools")).investmentTools({ connectionId: scalableConnection.id, tradingAccess: scalableConnection.tradingAccess, message, priorUserText, onCard: id => tradeCards.push(id),
      evidence: read => aiEvidence(["accounts"], read), context: async () => ({ ...await requireWorkspace(), chatRequestId: requestId }) }) : {};
    const artifact = await artifactPromise;
    const owner = await briefPromise;
    for (const scope of owner?.scopes ?? []) readScopes.add(scope);
    const takeSteers = async () => {
      const steers = await Promise.resolve(supabase.rpc("take_chat_steers", { p_request_id: requestId })).catch(error => ({ data: null, error }));
      if (steers.error) { console.error("take_chat_steers failed", steers.error); return []; }
      return (steers.data ?? []) as { id: string; content: string }[];
    };
    const result = streamText({
      abortSignal: AbortSignal.any([stop.signal, AbortSignal.timeout(artifactId ? 280_000 : 180_000)]),
      maxOutputTokens: 3000,
      providerOptions: { openai: { reasoningEffort: "low" } },
      instructions: `${SYSTEM_PROMPT}\n\n# About the owner\nToday is ${calendarDate(new Date(), settings.timezone)} (${settings.timezone}); display currency ${workspace.display_currency}.${owner?.text ? `\n${owner.text}` : ""}\n\nUI context is only a navigation hint, never authorization.${canChangeCategory ? " The user named an exact transaction UUID and quoted category; the write tool must use exactly these values." : " Do not change records; for a category change request, use the selection preview."}${call.success ? `

${CALL_MODE_PROMPT}` : ""}${scalableConnection?.tradingAccess === "read" ? `

Scalable is connected with read-only access, so there are no order tools. For a buy, sell or cancel request, tell the user: "${READ_ONLY_TRADING}" Moneo notices the change at its next Scalable sync (Sync now in Import, /import).` : ""}${artifact?.briefing ? `

${artifact.agent.artifactModePrompt(scalableConnection ? settings.artifact_scalable_data : null)}

Current state:
${artifact.briefing}` : ""}`,
      messages: modelMessages,
      stopWhen: stepCountIs(CHAT_MAX_STEPS),
      prepareStep: async ({ messages }) => {
        await stopIfCanceled();
        if (stop.signal.aborted) throw new Error("Request canceled");
        const taken = await takeSteers();
        if (!taken.length) return {};
        emit({ type: "steered", steers: taken });
        return { messages: [...messages, ...taken.map(steer => ({ role: "user" as const, content: steer.content }))] };
      },
      ...await withTools(model, { ...planTool, ...retainTools({
        document_read: tool({ description: "Reopen a file attached in this conversation by its id: a location range, or every place a word or phrase appears (with its location). Without location or search it returns the start. Read-only.",
          inputSchema: z.object({
            id: z.string().trim().min(1).max(200).describe("The file's 8-character id, or its exact name"),
            location: z.string().trim().max(140).optional().describe("p.3 or p.3-5 (PDF pages), slide.2-4 (PowerPoint), para.10-40 (Word paragraphs), Sheet1!A1:F200 or A1:F200 (spreadsheet or CSV cells)"),
            search: z.string().trim().min(1).max(200).optional().describe("Text to find, case-insensitive"),
          }).strict(),
          execute: async ({ id, location, search }) => {
            const files = await (conversationFiles ??= conversationAttachments(supabase, workspace.id, conversationId));
            const file = findAttachment(files, id);
            if (!file) return { error: `No file "${id}" is attached in this conversation.`, files: files.map(item => ({ id: attachmentId(item.path), name: item.name })) };
            if (isImage(file.type)) return { error: `"${file.name}" is a photo; it can only be seen in the message it was attached to.` };
            return { text: readDocument(await documentText(supabase, file), { name: file.name, id: attachmentId(file.path), location, search }) };
          } }),
        ...(artifact && artifactId ? artifact.agent.artifactTools({ context, artifactId, requestId, branch: artifact.branch, model: chosenModel, scalable: scalableConnection ? settings.artifact_scalable_data : null, ownerWords: [message, ...priorUserText.filter(text => text !== message)], session: artifact.session, signal: stop.signal, ensureActive: async () => { await stopIfCanceled(); if (stop.signal.aborted) throw new Error("Request canceled"); } }) : {}),
        ...(canInvestigate ? {
          finance_investigate: tool({ description: "Answer the actual chosen finance question deterministically: exact current/comparison dates, include/exclude owned account/category/merchant names or IDs, tags/events, posted/pending and classification semantics, multiple groupings, ranking, and complete paginated support. Original currencies stay separate; base uses direct exact posting-date FX and canonical split rounding. Use returned interpretedFilters and live evidence link; never imply full statements or bounds. Read-only, no approval needed.", inputSchema: investigationSchema, execute: input => aiEvidence(["accounts", "transactions"], latest => runInvestigation(input, latest, { canReadImports: latest.settings.ai_data_scopes.includes("imports"), sourceVersions: false }), false, true) }),
          finance_entities: tool({ description: "Optional: list owned account, category and merchant names with ids, tags and events. Other tools already accept names and label ids with names.", inputSchema: z.object({}).strict(), execute: () => aiEvidence(["accounts", "transactions"], latest => loadInvestigationEntities(latest)) }),
          finance_detail: tool({ description: "Read an owned canonical transaction with its effective split/fee components, or a recurring series with complete paginated source transactions. Classification warnings remain explicit.", inputSchema: investigationDetailSchema, execute: input => aiEvidence(input.kind === "recurring" ? ["accounts", "transactions", "planning"] : ["accounts", "transactions"], latest => investigationDetail(input, latest, { canReadImports: latest.settings.ai_data_scopes.includes("imports") }), false, true) }),
          finance_scenario: tool({ description: "Compare the same investigation against at most 100 hypothetical effective-record amount/date/category overrides. Read-only; canonical ledger, sources, balances and recurrence remain unchanged. Use exact minor-unit strings and owned effective IDs.", inputSchema: investigationScenarioSchema, execute: input => aiEvidence(["accounts", "transactions"], latest => evaluateInvestigationScenario(input, latest, { canReadImports: latest.settings.ai_data_scopes.includes("imports") }), false, true) }),
        } : {}),
        ...(replaceable ? { call_replace_task: tool({ description: `Only when the user explicitly drops their latest request from this call ("${replaceable.text.slice(0, 80)}", requestId ${replaceable.requestId}) for this one, as in "leave that, do this" or "no, I meant last month". Otherwise both run. Stops it, or lets it finish and dismisses its cards. Call before answering this request.`,
          inputSchema: z.object({ requestId: z.uuid() }).strict(), execute: async ({ requestId: target }) => {
            if (target !== replaceable.requestId) throw new Error("Only the latest request from this call can be replaced");
            return replaceCallTask(supabase, { workspaceId: workspace.id, conversationId, requestId: target });
          } }) } : {}),
        ...(settings.ai_data_scopes.includes("transactions") ? { agents_findings: tool({ description: "Read what the agent team found in its recent runs: open proposals (categorizations, recurring bills, budgets, anomaly findings) with ids, plus each run's briefing and page link. Set includeDecided to also see accepted and dismissed ones.",
          inputSchema: z.object({ includeDecided: z.boolean().optional() }).strict(), execute: ({ includeDecided }) => aiEvidence(["transactions"], latest => agentFindings(latest.supabase, workspace.id, { includeDecided })) }) } : {}),
        ...(settings.ai_data_scopes.includes("transactions") ? { organize_review: tool({ description: "Read what the organizer (the AI that labels categories and merchants) has done: decisions lists rows labelled by the AI, a rule, a confirmed payee or the bank's data with who decided, confidence, reason and the payee's identityId; memory lists what the owner told it each payee is. Read-only; the owner reviews and undoes on the AI organizer page (/money/organize).",
          inputSchema: organizeReviewSchema, execute: input => aiEvidence(["transactions"], latest => organizeReview(latest, input)) }) } : {}),
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
        ...(canInvestigate ? { reviews_investigate: tool({ description: "Investigate the selected query or an explicitly dated default review, with exact spending changes, account evidence, classification limitations and permitted planning evidence. Read-only.", inputSchema: z.object({ query: investigationSchema.optional() }).strict(), execute: ({ query } = {}) => aiEvidence(["accounts", "transactions"], async latest => {
          const { loadFinancialReviewEvidence } = await import("@/lib/finance/review-loader");
          return loadFinancialReviewEvidence(latest.supabase, latest.workspace, { timezone: latest.settings.timezone, scopes: latest.settings.ai_data_scopes, now: new Date() }, query);
        }, true, true) }) } : {}),
        ...(canInvestigate ? { reviews_start: tool({ description: "Investigate the current user's finance question through a bounded, durable, cancelable review. Preserve their chosen dates, entities and focus in query/focus; the application binds the exact question and visible navigation context. Use ordinary finance queries for quick answers, and this tool when follow-up evidence gathering or a saved report is useful. Do not start when the user declines investigation or only asks what a review does. Repeated calls reuse one job; no canonical financial changes.", inputSchema: reviewRequestSchema.omit({question: true, version: true, context: true, allowedScopes: true}), execute: (input = {includePlanning: false, output: "answer", budget: {maxQueries: 6, maxSupportRecords: 60, maxOutputTokens: 4000, maxDurationMs: 90000}}) => scopedTool(["accounts", "transactions"], async latest => {
          if (stop.signal.aborted) throw new Error("Request canceled");
          if (!serviceRoleConfig()) throw new Error("Financial review service is not configured");
          const specification = resolveReviewRequest({...input, version: 1, question: message, context: capturedContext, allowedScopes: settings.ai_data_scopes}, calendarDate(new Date(), settings.timezone));
          if (specification.includePlanning) requireAiScope(latest.settings, "planning");
          const { startFinancialReview } = await import("@/lib/finance/start-review");
          return { ...await startFinancialReview(latest.supabase, workspace.id, requestId, requestId, specification), href: "/ai" };
        }) }) } : {}),
        ...scalableTools,
        ...(settings.ai_data_scopes.includes("accounts") ? { chart_data: tool({ description: "Exact data for a chart: spending by category, merchant, month or day, income vs spending by month (with month-end balance), an account's daily balance, or net worth over time. Returns a datasetId the moneo-chart block references, so you never copy its numbers.",
          inputSchema: chartDataInput, execute: input => aiEvidence(chartDataScopes(input.dataset), async latest => {
            const loaded = await loadChartData(latest, input, { canReadImports: latest.settings.ai_data_scopes.includes("imports") });
            return describeDataset(charts.add(loaded.dataset), loaded, latest.workspace.locale);
          }, false, true) }) } : {}),
        ...(settings.ai_data_scopes.includes("accounts") ? { accounts_list: tool({ description: "List the user's accounts", inputSchema: z.object({}), execute: () => aiEvidence(["accounts"], latest => listAccounts(latest)) }),
        accounts_getBalances: tool({ description: "Get dated balances, provenance and source coverage", inputSchema: z.object({}), execute: () => aiEvidence(["accounts"], latest => getBalances(latest, latest.settings.ai_data_scopes.includes("imports")), false, true) }) } : {}),
        ...(settings.ai_data_scopes.includes("transactions") ? { analytics_cashflow: tool({ description: "Exact accepted posted income/spending with source coverage. Choose view base for direct exact posting-date FX and per-canonical-posting half-away rounding, or original for separate currency subtotals. Omitted view preserves single-currency accounting. Conversion completeness does not prove statement completeness; partial totals are not bounds. Missing rates return incomplete evidence, never guessed money.", inputSchema: financeToolSchemas.periodInput, execute: input => aiEvidence(["transactions"], latest => cashflow(input, latest, latest.settings.ai_data_scopes.includes("imports")), false, true) }),
        transactions_search: tool({ description: "Find transactions, newest first within each kind of match. Filter by description text (rows containing it come first with match \"text\", then rows whose description is similar, such as a nickname or typo of the name, with match \"similar_name\": judge those yourself), posted date range (from/to), absolute amount range in minor units, and limit (default 20, max 50). Names are loose (nicknames, short forms, typos; messy bank text): a close name alone is not a match, the amount, currency and direction must fit too. An empty result usually means a bad search: try a shorter part of the name, or the amount with a date range, before saying it isn't there.", inputSchema: financeToolSchemas.searchInput, execute: input => aiEvidence(["transactions"], latest => searchTransactions(input, latest)) }) } : {}),
        ...(settings.ai_data_scopes.length ? { data_query: tool({ description: dataQueryDescription(settings.ai_data_scopes), inputSchema: dataQueryInput,
          execute: ({ sql, maxRows, chart }) => aiEvidence(settings.ai_data_scopes, async latest => {
            try {
              const result = await runDataQuery(latest.supabase, sql, settings.ai_data_scopes, maxRows);
              return { ...dataQueryOutput(result), ...(chart && { datasetId: charts.add(dataQueryChartDataset(result, chart.columns)) }) };
            }
            catch (error) { if (error instanceof DataQueryError) return { error: error.message }; throw error; }
          }, false, false) }) } : {}),
        ...(canInvestigate ? { iou_findRepayments: tool({ description: "Check recent bank transactions for repayments of money the user lent to or borrowed from people, and show each as a card to accept or dismiss. Nothing changes until they accept.", inputSchema: z.object({}).strict(),
          execute: () => scopedTool(["accounts", "transactions"], async latest => {
            const found = await proposeRepayments({ ...latest, chatRequestId: requestId });
            proposalCards.push(...found.map(item => item.id as string));
            return { found: found.map(item => item.title), note: found.length ? "Cards are shown to the user below your answer." : "No new repayments found." };
          }) }) } : {}),
        ...(settings.ai_data_scopes.includes("planning") && settings.ai_data_scopes.includes("transactions") ? { recurring_list: tool({ description: "List confirmed recurring payments and income (id, name, amount, direction, cadence, next date, category) and detected suggestions not yet confirmed. Use before recurring_propose to change, remove or confirm one.", inputSchema: z.object({}).strict(), execute: () => aiEvidence(["transactions", "planning"], latest => listRecurring(latest)) }) } : {}),
        ...(settings.ai_data_scopes.includes("planning") ? { goals_list: tool({ description: "List the user's goals", inputSchema: z.object({}), execute: () => aiEvidence(["planning"], latest => listGoals(latest)) }),
        wealth_list: tool({ description: "List what the Wealth page holds: money the user lent to people and owes to people (by person), plus other assets, holdings and debts, with totals per currency. Use for questions like \"how much have I lent and to whom\" or \"what do I owe\".", inputSchema: z.object({}).strict(), execute: () => aiEvidence(["planning"], latest => listWealth(latest)) }) } : {}),
        ...(settings.ai_data_scopes.includes("planning") && settings.ai_data_scopes.includes("accounts") ? { net_worth: tool({ description: "The user's net worth, today or on any past date, from the same calculation as Home and Wealth: the total, its parts, this month's change split into money in and out, investments and newly added, what was left out, how fresh each input is, and transfers with one side so far. Pass `days` for a daily trend. Quote this total; never work out net worth from balances and wealth yourself.", inputSchema: netWorthInput, execute: input => aiEvidence(["accounts", "planning"], latest => readNetWorth(latest, input)) }) } : {}),
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
      }) }, { take: takeSteers, delivered: steers => emit({ type: "steered", steers }) }),
    });
    let text = "", stepBreak = false;
    const watchCancel = model.provider === "claude-code" ? setInterval(() => void stopIfCanceled(), 2000) : undefined;
    try {
      for await (const part of result.fullStream) {
        if (part.type === "text-delta" && part.text) {
          const delta = stepBreak && text.trim() ? `\n\n${part.text}` : part.text;
          stepBreak = false; text += delta;
          emit({ type: "delta", text: delta });
          startTitle();
        } else if (part.type === "finish-step") stepBreak = true;
        else if (part.type === "error") throw part.error instanceof Error ? part.error : new Error("AI request failed");
      }
    } finally { clearInterval(watchCancel); }
    const [usage, steps] = await Promise.all([result.totalUsage, result.steps]);
    if (!text.trim()) throw new Error("The model returned no answer");
    const cards = [...new Set(proposalCards)];
    const cardBlocks = cards.length > 1 ? ["```moneo-proposals\n" + JSON.stringify(cards) + "\n```"] : cards.map(id => "```moneo-proposal\n" + id + "\n```");
    const answer = [resolveChartBlocks(text.trim(), charts.get), ...cardBlocks, ...[...new Set(tradeCards)].map(id => "```moneo-proposal\n" + id + "\n```"), ...new Set(decisionCards)].join("\n\n");
    const current = await requireWorkspace();
    if (current.workspace.id !== workspace.id) throw new Error("Workspace changed");
    if (stop.signal.aborted) throw new Error("Request canceled");
    requireAiScope(current.settings, ...readScopes);
    const toolsUsed = [...new Set(steps.flatMap(step => step.toolResults.flatMap(toolResult => toolResult ? [moneoToolName(toolResult.toolName)] : [])))];
    const followUps = chatFollowUps(message, toolsUsed, modelFollowUps);
    emit({ type: "answer", conversationId, answer, toolsUsed, followUps, model: model.modelId, parent: claimedParent });
    const finished = await supabase.rpc("finish_chat_request", { p_request_id: requestId, p_status: "completed", p_content: answer,
      p_usage: reportedUsage(model.modelId, usage), p_tool_calls: toolCalls });
    if (finished.error) throw finished.error;
    if (finished.data !== "completed") return [{ status: finished.data, error: `Request is ${finished.data}` }, 409];
    return [{ conversationId, answer, toolsUsed, followUps, model: model.modelId, parent: claimedParent }, 200];
  } catch (error) {
    const failure = error instanceof Error ? error.message : "AI request failed";
    await supabase.rpc("finish_chat_request", { p_request_id: requestId, p_status: "failed", p_content: failure.slice(0, 500) });
    return stop.signal.aborted ? [{ status: "canceled", error: "Request is canceled" }, 409] : [{ error: failure }, 502];
  } finally {
    startTitle();
  }
  }
  if (!streaming) { const run = complete(() => {}); after(() => Promise.all([run, chatTitle])); const [body, status] = await run; return Response.json(body, { status }); }
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) {
    const write = (event: ChatStreamEvent) => { try { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); } catch { streamEndsWhenTheClientLeaves(); } };
    write({ type: "started" });
    void chatTitle.then(title => { if (title) write({ type: "title", title }); });
    const run = complete(write);
    after(() => Promise.all([run, chatTitle]));
    void run.then(async ([body, status]) => {
      await Promise.race([chatTitle, new Promise(resolve => setTimeout(resolve, TITLE_WAIT_MS))]);
      write({ type: "result", status, body });
      try { controller.close(); } catch { streamEndsWhenTheClientLeaves(); }
    });
  } }), { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}


export async function PATCH(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const parsed = z.object({ requestId: z.uuid() }).strict().safeParse(await jsonBodyOrNull(request));
  if (!parsed.success) return Response.json({ error: "Invalid cancellation" }, { status: 400 });
  const result = await context.supabase.rpc("cancel_chat_request", { p_request_id: parsed.data.requestId });
  if (result.error) return Response.json({ error: result.error.message }, { status: result.error.code === "P0002" ? 404 : 400 });
  return Response.json({ status: result.data });
}


import { generateText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { getModel, SYSTEM_PROMPT } from "@/lib/ai/provider";
import { requireWorkspace } from "@/lib/auth";
import { isExplicitCategoryChange } from "@/lib/ai/write-intent";
import { cashflow, evaluateForecast, getBalances, listAccounts, listGoals, searchTransactions } from "@/lib/finance/tools";

const inputSchema = z.object({
  conversationId: z.uuid(),
  requestId: z.uuid(),
  message: z.string().trim().min(1).max(4000),
  context: z.record(z.string(), z.unknown()).optional(),
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
  const { supabase, workspace } = context;
  const existing = await supabase.from("conversations").select("id").eq("workspace_id", workspace.id).eq("id", conversationId).maybeSingle();
  if (existing.error) throw existing.error;
  if (!existing.data) {
    const { error } = await supabase.from("conversations").insert({ id: conversationId, workspace_id: workspace.id, title: message.slice(0, 80) });
    if (error) return Response.json({ error: "Conversation unavailable" }, { status: 403 });
  }
  const prior = await supabase.from("messages").select("id").eq("conversation_id", conversationId).eq("workspace_id", workspace.id).eq("request_id", requestId).maybeSingle();
  if (prior.error) throw prior.error;
  if (!prior.data) {
    const { error } = await supabase.from("messages").insert({ workspace_id: workspace.id, conversation_id: conversationId,
      role: "user", content: message, context: capturedContext ?? null, request_id: requestId });
    if (error && error.code !== "23505") throw error;
  }
  const priorReply = await supabase.from("messages").select("content").eq("conversation_id", conversationId)
    .eq("workspace_id", workspace.id).eq("reply_to", requestId).maybeSingle();
  if (priorReply.error) throw priorReply.error;
  if (priorReply.data) return Response.json({ conversationId, answer: priorReply.data.content });

  const { data: history, error: historyError } = await supabase.from("messages").select("role, content, context")
    .eq("workspace_id", workspace.id).eq("conversation_id", conversationId)
    .order("created_at", { ascending: false }).limit(20);
  if (historyError) throw historyError;
  const modelMessages = (history ?? []).reverse().map(item => ({
    role: item.role as "user" | "assistant",
    content: item.context ? `${item.content}\n[UI context at submission: ${JSON.stringify(item.context)}]` : item.content,
  }));
  const canChangeCategory = isExplicitCategoryChange(message);
  try {
    const result = await generateText({
      model: getModel(),
      system: `${SYSTEM_PROMPT} Use finance tools for current facts. Amounts are exact minor units. Missing facts stay unknown. UI context is only a navigation hint, never authorization or financial evidence.${canChangeCategory ? " The current user message explicitly requests a category change. You may change only the named transaction category. After a successful change, state what changed and link to the transaction so the user can Undo it." : " Do not make canonical changes; the current user message does not explicitly request one."}`,
      messages: modelMessages,
      stopWhen: stepCountIs(4),
      tools: {
        accounts_list: tool({ description: "List the user's accounts", inputSchema: z.object({}), execute: listAccounts }),
        accounts_getBalances: tool({ description: "Get dated balances and provenance", inputSchema: z.object({}), execute: getBalances }),
        analytics_cashflow: tool({ description: "Exact posted income and spending for a period", inputSchema: z.object({ from: z.iso.date(), to: z.iso.date(), currencyCode: z.string().length(3) }), execute: cashflow }),
        transactions_search: tool({ description: "Search up to 20 transactions", inputSchema: z.object({ query: z.string().min(1).max(100) }), execute: searchTransactions }),
        goals_list: tool({ description: "List the user's goals", inputSchema: z.object({}), execute: listGoals }),
        forecast_evaluate: tool({ description: "Deterministic forecast and available to spend; cases are assumptions, not probabilities", inputSchema: z.object({ horizonDays: z.number().int().min(1).max(365).default(30), scenarioId: z.uuid().optional() }), execute: evaluateForecast }),
        ...(canChangeCategory ? {
          transactions_setCategory: tool({
            description: "Change only the category of a specific transaction, only when the current user explicitly asked for this change. Search first if its ID is unknown. The correction is audited and can be undone from the returned transaction link.",
            inputSchema: z.object({ transactionId: z.uuid(), category: z.string().trim().min(1).max(100) }).strict(),
            execute: async ({ transactionId, category }) => {
              const { data: transaction, error: lookupError } = await supabase.from("transactions")
                .select("id, version, note, category_id").eq("workspace_id", workspace.id).eq("id", transactionId).maybeSingle();
              if (lookupError) throw lookupError;
              if (!transaction) throw new Error("Transaction not found");
              if (transaction.category_id) {
                const { data: currentCategory, error } = await supabase.from("categories").select("name")
                  .eq("workspace_id", workspace.id).eq("id", transaction.category_id).maybeSingle();
                if (error) throw error;
                if (currentCategory?.name === category) return { status: "already_set", category };
              }
              const { error } = await supabase.rpc("correct_transaction", {
                p_transaction_id: transaction.id,
                p_expected_version: transaction.version,
                p_category_name: category,
                p_note: transaction.note ?? "",
              });
              if (error) throw error;
              return { status: "updated", category, transactionUrl: `/money/transactions?transaction=${transaction.id}` };
            },
          }),
        } : {}),
      },
    });
    const answer = result.text.trim() || "I could not produce an answer from the available data.";
    const { error } = await supabase.from("messages").insert({ workspace_id: workspace.id, conversation_id: conversationId,
      role: "assistant", content: answer, reply_to: requestId });
    if (error && error.code !== "23505") throw error;
    return Response.json({ conversationId, answer });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "AI request failed" }, { status: 502 });
  }
}

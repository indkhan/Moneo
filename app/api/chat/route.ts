import { streamText, convertToModelMessages, tool, stepCountIs, type UIMessage } from "ai";
import { z } from "zod";
import { getModel, SYSTEM_PROMPT } from "@/lib/ai/provider";
import { requireWorkspace } from "@/lib/auth";
import { cashflow, getBalances, listAccounts, searchTransactions } from "@/lib/finance/tools";

export async function POST(req: Request) {
  try {
    await requireWorkspace();
  } catch {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.OPENROUTER_API_KEY) {
    return Response.json(
      { error: "OPENROUTER_API_KEY is missing. Add it to .env (see .env.example)." },
      { status: 400 },
    );
  }
  const { messages }: { messages: UIMessage[] } = await req.json();
  if (!Array.isArray(messages) || messages.length > 40) return Response.json({ error: "Invalid messages" }, { status: 400 });
  const result = streamText({
    model: getModel(),
    system: `${SYSTEM_PROMPT} Use the finance tools for current facts. Amounts are exact minor currency units. If data is missing, say so. Never guess balances or totals.`,
    messages: await convertToModelMessages(messages),
    stopWhen: stepCountIs(4),
    tools: {
      accounts_list: tool({ description: "List the user's accounts", inputSchema: z.object({}), execute: listAccounts }),
      accounts_getBalances: tool({ description: "Get dated account balances with provenance; missing balance means unknown", inputSchema: z.object({}), execute: getBalances }),
      analytics_cashflow: tool({ description: "Exact posted income and spending for a date range and currency", inputSchema: z.object({ from: z.iso.date(), to: z.iso.date(), currencyCode: z.string().length(3) }), execute: cashflow }),
      transactions_search: tool({ description: "Search up to 20 transactions by description", inputSchema: z.object({ query: z.string().min(1).max(100) }), execute: searchTransactions }),
    },
  });
  return result.toUIMessageStreamResponse();
}

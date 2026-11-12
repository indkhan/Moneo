import type { ScalableMcp } from "./client";

// Reviewed reads: upstream annotations and model-provided names cannot grant write access.
const READS = new Set(["get_portfolio_holdings", "get_portfolio_overview", "get_portfolio_cash_breakdown", "list_portfolio_transactions",
  "get_transaction_details", "list_watchlist_items", "get_security_quote", "search_securities", "get_security_chart", "get_security_news"]);

export async function scalableReadTools(mcp: ScalableMcp) {
  return (await mcp.listTools()).filter(tool => READS.has(tool.name));
}

export async function scalableRead(mcp: ScalableMcp, name: string, args: Record<string, unknown>) {
  if (!READS.has(name)) throw new Error("This Scalable operation is not an approved read; financial writes require an approval card");
  if (!(await scalableReadTools(mcp)).some(tool => tool.name === name)) throw new Error("Scalable does not offer this read operation");
  return mcp.callTool(name, args);
}

import { describe, expect, it, vi } from "vitest";
import type { ScalableMcp } from "@/lib/scalable/client";

// Every Scalable call made through the chat tools is recorded, so the test can prove none of them submits.
const calls: string[] = [];
const mcp = { connect: async () => {}, listTools: async () => [], callTool: vi.fn(async (name: string) => { calls.push(name); return {}; }) } as unknown as ScalableMcp;
vi.mock("@/lib/scalable/server", () => ({ withScalable: (_: string, __: string, work: (client: ScalableMcp) => Promise<unknown>) => work(mcp) }));
const { investmentTools, TRADE_INTENT } = await import("./investment-tools");

const build = (message: string, priorUserText: string[] = [], tradingAccess: "full" | "read" | null = "full") => investmentTools({ connectionId: "c", tradingAccess, message, priorUserText, onCard: () => {},
  evidence: read => read({ workspace: { id: "ws" } } as never), context: async () => ({ workspace: { id: "ws" } }) as never });

describe("Scalable chat tools", () => {
  it("composes paginated history, holdings and exact calculations without counting securities still owned", async () => {
    const tools = build("profit on securities I fully sold") as unknown as Record<string, { execute: (input: unknown) => Promise<unknown> }>;
    const row = (id: string, isin: string, side: string, amount: string) => ({ id, kind: "security", status: "SETTLED", lastEventAt: "2026-01-01", currency: "EUR", security: { isin, side, amount, quantity: "1" } });
    vi.mocked(mcp.callTool).mockImplementation(async (name, args) => {
      if (name === "get_portfolio_holdings") return { holdings: [{ isin: "HELD" }] };
      if (name === "list_portfolio_transactions") return args?.cursor ? { transactions: [row("3", "CLOSED", "sell", "12"), row("4", "HELD", "sell", "100")], page: {} }
        : { transactions: [row("1", "CLOSED", "buy", "10"), row("2", "HELD", "buy", "50")], page: { nextCursor: "page2" } };
      return {};
    });
    const first = await tools.investments_transactions.execute({}) as { datasetId: string; data: { nextCursor: string } };
    const second = await tools.investments_transactions.execute({ cursor: first.data.nextCursor }) as { datasetId: string };
    const all = await tools.investments_transactions.execute({ allPages: true }) as { data: { transactions: unknown[]; more: boolean } };
    expect(all.data.transactions).toHaveLength(4);
    expect(all.data.more).toBe(false);
    // Raw reads use the same evidence boundary and preserve fields that convenient summaries omit.
    vi.spyOn(mcp, "listTools").mockResolvedValue([{ name: "get_portfolio_holdings" }]);
    const held = await tools.investments_read.execute({ name: "get_portfolio_holdings", arguments: {} }) as { datasetId: string };
    expect(await tools.investments_calculate.execute({ datasetIds: [first.datasetId, second.datasetId, held.datasetId], code: `
      const sets = Object.values(data.datasets);
      const owned = new Set(sets[2].holdings.map(h => h.isin));
      const rows = sets.slice(0,2).flatMap(p => p.transactions).filter(t => !owned.has(t.isin));
      return rows.reduce((sum,t) => sum + (t.type === 'sell' ? 1n : -1n) * BigInt(t.amountMinor), 0n);
    ` })).toBe("200");
    await expect(tools.investments_read.execute({ name: "submit_sell_order", arguments: {} })).rejects.toThrow("approval card");
    await expect(tools.investments_calculate.execute({ datasetIds: [first.datasetId], code: "return 0;" }).then(() => {
      const fresh = build("another request") as unknown as typeof tools;
      return fresh.investments_calculate.execute({ datasetIds: [first.datasetId], code: "return 0;" });
    })).rejects.toThrow("Unknown dataset");
    vi.mocked(mcp.callTool).mockImplementation(async () => ({ transactions: [], page: { nextCursor: "same" } }));
    await expect(tools.investments_transactions.execute({ cursor: "same" })).rejects.toThrow("incomplete");
    vi.mocked(mcp.callTool).mockImplementation(async name => { calls.push(name); return {}; });
  });
  it("never gives the model a tool that submits or cancels on Scalable", () => {
    const names = Object.keys(build("buy 2 shares of Alphabet and cancel my open order"));
    expect(names.sort()).toEqual(["investments_calculate", "investments_cancelOrder", "investments_order", "investments_portfolio", "investments_read", "investments_readTools", "investments_security", "investments_transactions", "investments_watchlist"]);
    expect(names.some(name => /submit|cancel_order|place/.test(name))).toBe(false);
  });

  it("offers order cards only when the user asked to trade, here or just before", () => {
    expect(build("How is my portfolio doing?")).not.toHaveProperty("investments_order");
    expect(build("ok do it, 2 shares", ["Should I buy more silver?"])).toHaveProperty("investments_order");
    expect(TRADE_INTENT.test("Verkaufe meine Alphabet Aktie")).toBe(true);
  });

  it("leaves out order cards when Scalable is connected read-only", () => {
    expect(build("buy 2 shares of Alphabet", [], "read")).not.toHaveProperty("investments_order");
    expect(build("cancel my open order", [], "read")).not.toHaveProperty("investments_cancelOrder");
    // Not known yet (connected before access was recorded): the order tool checks Scalable live.
    expect(build("buy 2 shares of Alphabet", [], null)).toHaveProperty("investments_order");
  });

  it("reads Scalable without ever calling a write tool", async () => {
    calls.length = 0;
    const tools = build("show my portfolio") as unknown as Record<string, { execute: (input: unknown) => Promise<unknown> }>;
    await Promise.allSettled([tools.investments_portfolio.execute({}), tools.investments_transactions.execute({}), tools.investments_watchlist.execute({}),
      tools.investments_security.execute({ action: "search", query: "MSCI World" })]);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some(name => /^(submit|cancel|preview|create|add|remove|upsert)_/.test(name))).toBe(false);
  });
});
